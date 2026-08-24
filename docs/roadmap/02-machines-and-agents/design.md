# 机器与 agent —— 技术方案

对应 `prd.md`。只写这一片要建的东西。

## owner

| owner     | 拥有                                       | 恢复错误                               |
| --------- | ------------------------------------------ | -------------------------------------- |
| `machine` | 机器、它的凭据、接入请求、发现出来的 agent | 码不对 / 过期 / 已用 / 被拒 / 钥匙无效 |

`machine` 不知道邮箱和浏览器会话,`identity` 不知道机器。两边只在一个地方相遇:**批准这个动作由一个人做**,所以接入请求上有一个指向 `users` 的外键。

## 数据

```
enrolments
  id · space_id(批准前为空) · machine_name
  secret_hash 唯一          ← 命令行轮询时出示的东西,只存哈希
  user_code   唯一(可空)     ← 给人看的短码;网页生成的那条路没有
  approved_by → users(可空) · approved_at(可空)
  refused_at(可空)          ← 被拒绝和从没批过是两件事
  claimed_at(可空)          ← 已经换成机器了,不能再换第二次
  expires_at
  一行 = 一次接入请求。批没批,看 approved_at

machines
  id · space_id · name
  token_hash 唯一           ← 长期凭据,同样只存哈希
  enrolled_from → enrolments
  last_seen_at              ← 在线与否读的时候算,不存状态
  removed_at(可空)
  created_at

agents
  machine_id · kind · version · 唯一(machine_id, kind)
  一台机器上扫到的东西。没有状态列:机器离线,它上面的 agent 就都不可用
```

**不建**:`machines.status`(派生)· agent 的 `last_seen_at`(跟机器走)· 机器分组 · 能力表。

### 为什么接入请求和机器凭据是两条命

一把钥匙可能被贴到十台服务器上。泄露一把钥匙不该等于泄露十台机器的长期凭据,而且撤销一台机器不该连累另外九台。GitHub(1 小时注册 token → 长期 runner 凭据)和 Tailscale(auth key → node key)都这么分。

### 为什么只有 `last_seen_at`

存 `status` 就得在关机时去改它,而进程被 `kill -9` 改不掉,于是库里会留下一台"在线"的死机器。`last_seen_at` 加一个读时阈值不会和事实不一致 —— **这是 `architecture.md` 那条「派生而非存储」在这一片的具体形态。**

## 决定

**① 机器不选 Space,批准的人选**

`POST /enrolments` 不要会话 —— 一台还没被批准的机器没有任何身份可言。正因为如此,它**不能**报自己
要进哪个 Space:那会让一个没登录的人拿 slug 挨个试,从 201 还是 404 里读出哪个 Space 存在,而
`prd.md` 01 的承诺 ⑥ 说的是**不存在和不是成员,同一个回答**。

Space 在批准的那一刻由人给出。Tailscale 就是这样:设备不选网络,授权的账号选。

`space_id` 因此在批准前为空,并由一条约束钉住:**批过的行一定有 Space**。

**② 两条接入路径共用一张表,区别只在建的时候批没批**

```
笔记本  命令行建一行:未批准、有 user_code、secret 只有它自己知道
        → 人在任意设备上批 → approved_at 落下
        → 命令行轮询发现批了 → 拿 secret 换机器凭据 → claimed_at 落下

服务器  人在网页上建一行:approved_at 当场落下、没有 user_code
        → 明文只回一次 → 粘到机器上 → 换机器凭据
```

**auth key 不是另一套机制,是一条已经批过的接入请求。** 这条来自 Tailscale —— 它的 key 属性里就有一个 `pre-approved`。

**③ 用设备码,不用本地回调**

本地回调(命令行在 `127.0.0.1` 开个端口等浏览器跳回来)要求**浏览器能连到命令行所在的机器**。命令行在服务器上就连不到,于是要么让用户开 SSH 隧道,要么去猜自己的出口 IP 判断拓扑。

设备码对网络零假设,因为**根本没有回调**:命令行只是拿着自己的 secret 去轮询。

轮询的回答照抄那套标准,因为四种情况都是真的:

```
还没批    接着等
太快了    间隔 +5 秒
过期了    15 分钟,重来
被拒了    终态,不能重试
```

**④ 用户码用 RFC 8628 那个字符集,并且干净网址是主路径**

字符集是 `BCDFGHJKLMNPQRSTVWXZ` —— 大小写不敏感的 A–Z,**去掉全部数字,再去掉元音**。

- 全字母就不存在 `0/O`、`1/I` 认错的问题,不用一条条排除
- **去掉元音是为了不随机拼出单词**,免得给人发一个骂人的码
- 八位 `WDJB-MJHT`,`20^8` ≈ 256 亿

命令行打两行:干净网址加码,以及一个带码的完整网址(标准里的 `verification_uri_complete`,存在的理由是二维码这类"非文本传输")。**能复制就点第二行,拿手机对着服务器屏幕就念第一行。**

**带码的那个是加速通道,不是主路径。** 标准明确不建议把码塞进主网址,理由不是安全是可用性:

> It is NOT RECOMMENDED for authorization servers to include the user code in the `verification_uri`... The rationale emphasizes that **allows users to receive error feedback about code entry after successfully reaching the URI**.

只给带码长网址的话,**输错一个字符得到的是 404,而不是「这个码不对」** —— 页面都到不了,就没地方说哪儿错了。

字符集和分组是纯规则,住在 `machine` owner 里,测试钉住:**不含数字、不含元音、不随机成词。**

**⑤ 机器的凭据不是 `credentials` 表里的一行**

那张表是**人**的:一行是一把能打开浏览器那扇门的东西。机器凭据打不开那扇门,人凭据也当不了机器。两张表、两个中间件、两种 401。

四家调研对象无一例外都这么分:Multica 的 `mul_`(人)对 `mcn_`(节点),Coder 的 session key 对 agent token,GitHub 的 PAT 对 runner credentials,Tailscale 的用户登录对 node key。

**⑥ 发现是扫 PATH 对一张写死的清单**

不是插件协议,不是让 agent 自己注册。一张 `kind → 命令名` 的表,`--version` 问一次版本。四家一致。

第一版三个:`claude` · `codex` · `cursor-agent`。**清单是纯数据,住在 owner 里**,加一个 agent 是清单里加一行,不动别的。

发现在**每次报到时**做,不只是启动时。别人 `brew upgrade` 之后我们跟着更新版本号,不重启、不重接。

**⑦ 常驻交给操作系统,而且用什么身份跑决定装哪一种**

```
不是 root  →  用户服务   ~/Library/LaunchAgents/  或  ~/.config/systemd/user/
是 root    →  系统服务   /etc/systemd/system/
```

这条判断抄 `brew services`:

```ruby
def self.scope
  System.root? ? "--system" : "--user"
end
```

**两种服务的语义不是我们调出来的,是它们各自的定义。** Syncthing 的文档写得最直白:用户服务"只在用户登录之后启动",用于 "a desktop computer";系统服务"即使没有活动会话也在开机时运行",用于 "a server"。

**不开 `enable-linger`** —— 开了用户服务就变成开机启动,笔记本就成了服务器语义,那正是要防的。

只支持 systemd 和 launchd。pm2 和 cloudflared 要支持 sysv / openrc / upstart,是因为它们得跑在十年前的发行版上。两个都探测不到就打印出来让人自己装 —— 兜底,不是主路径。

**自己不后台化。** 没有 pid 文件、没有 profile 目录、没有自己发明的日志目录;stdout 交给 journald / launchd。Multica 那份文档里"两个 `daemon.log` 你不知道在看哪个"占了很大篇幅,而**那些复杂度全部是自己后台化的副产品**。

`handover run` 单独留着:前台、什么都不装。调试和"先看看能不能通"需要一个不碰服务的入口,GitHub runner 的 `run.sh` 就是这个位置。

**⑧ 启动用绝对路径,找 agent 问登录 shell**

服务不继承 shell 的 PATH。launchd 给的是 `/usr/bin:/bin:/usr/sbin:/sbin`,systemd 给的更少 —— **而这个 CLI 的核心工作就是扫 PATH 找 agent**。在终端里跑得好好的,装成服务之后一个都扫不到,报的还是"这台机器上没有 agent",完全指不到真正的原因。

两个问题,两个答案:

```
启动服务用什么      绝对路径,永不依赖 dotfile
                    brew services · cloudflared · Tailscale 一致

上哪儿找 agent      每次发现时问一次登录 shell($SHELL -lc),带超时
                    问不到就退回装的时候那份,并且在 status 里说清用的是哪份
```

**启动绝不能依赖 shell**:一个 `.zshrc` 里的笔误不该让服务起不来。**发现必须问 shell**:不然装了新 agent 扫不到,而那个错会骗人。

问登录 shell 是有名的做法也有名的坑 —— VS Code 的 `Unable to resolve your shell environment` 就是它,重的 shell 配置会超时。所以必须有超时和退化,而且 `handover status` 要打印**服务实际用的那份 PATH**,以及它是问来的还是退化的。

**⑨ 一个长轮询的端点,不是一个心跳端点**

```
POST /machines/current/poll     挂住约 25 秒
  带上   这台机器扫到的 agent 和版本
  返回   什么都没有  /  (下一片)一件活
```

**心跳不是独立的概念,是轮询的副作用**:每次轮询落一次 `last_seen_at`,顺便更新它扫到的东西。

这么设计是为了让下一片**往返回值里加东西,而不是删掉一个端点再加一个**。GitHub 的 runner 就是这个形状,而且它每次轮询都重报 `status, version, os, architecture` —— **发现自愈靠的就是这个,不需要单独一个上报能力的接口。**

**干净停止时说一声再见**(`DELETE /machines/current/session`),立刻转离线。GitHub 的 runner 退出时调 `DeleteSessionAsync` 是同一件事。**常见情况准确,异常情况才靠阈值猜。**

**⑩ 以后接长连接,变的只有传输**

`last_seen_at` 仍然是在线与否的唯一真相,WebSocket 只让延迟变短。

这不是洁癖,是多实例逼出来的:socket 挂在 A 实例上,而网页可能由 B 实例伺候,**B 看不见 A 的 socket**。Multica 的 WS 只送 `wakeup hints`,活还是机器自己拉,原因就是这个。

所以加长连接时:**表不动、产品不动,只换谁来写 `last_seen_at`、机器怎么更快知道有活。**

**⑪ 服务器永远不主动连机器**

不是偏好,是 NAT 和防火墙决定的:机器在别人家的网络里,连不进去。所以只能机器往外连着 —— **长期外连的进程这个形状是被逼出来的,不是选出来的。**

## 三态出现在哪

**这一片没有三态。**

注册和报到都没有"不知道成没成"的外部后果:调用失败就重试,重试是幂等的。三态要等到机器真的去跑一个 agent —— 那是下一片,也是 `architecture.md` §4 第一次被真正检验的地方。

先说清楚,免得这一片做完误以为那条已经验过了。

## 接口

```
POST   /enrolments                      命令行发起,不要会话,也不报 Space
                                        → { userCode, verifyUrl, verifyUrlComplete,
                                            interval, expiresAt }
POST   /enrolments/claim                命令行轮询,出示 secret → 未批 / 过期 / 被拒 / 机器凭据
GET    /enrolments/{userCode}           网页给人看:哪台机器、进哪个 Space
POST   /enrolments/{userCode}/approve   人批准
POST   /enrolments/{userCode}/refuse    人拒绝

POST   /spaces/{slug}/machine-keys      网页生成一条已批准的,明文只回一次

POST   /machines/current/poll           长轮询约 25 秒;带上扫到的 agent
DELETE /machines/current/session       干净停止时说再见,立刻转离线
GET    /spaces/{slug}/machines          Space 页面读这个
DELETE /machines/{id}                   移除
```

`/machines/current/…` 用机器自己的凭据,**路径里不带 id** —— 带了就得校验"这个 id 是不是你",而凭据本来就说明了你是谁。

**契约从路由本身导出**,和上一片一样:zod 是真相,OpenAPI 是产物。

## 达不到这个仓库标准的地方

到目前为止每条规则都有检查器,`db/` 和 `identity/` 是 100%。**装服务那个文件做不到,我不想假装它能。**

```
能测    生成的 plist / unit 内容对不对        断言文本
能测    操作系统认不认这个文件                plutil -lint · systemd-analyze verify,进 CI
能测    PATH 解析的退化逻辑                   把 $SHELL 换成一个假的
测不了  launchctl bootstrap 真的起来了没      人跑一次
测不了  Linux 上整条链路                      CI 容器能跑到"文件合法",跑不到"服务起来了"
```

`plutil -lint` 和 `systemd-analyze verify` 是操作系统自己的校验器,**把"我写的模板对不对"这半边还上了**。剩下的那半边只有人验过一次。

那个文件的文件头要写清**哪几行有测试、哪几行只有人试过**,免得以后有人以为它和别的文件一样安全。

另外一件事实:**Linux 那一半是在 macOS 上写的。** CI 里跑容器能验到文件合法,验不到真的能起来。第一台真实的 Linux 机器接进来之前,那条路只能算「写完了」,不算「验过了」。

## 风险

**长轮询挂住连接。** 一百台机器就是一百个挂起的请求。Node 扛得住,但它决定了以后横向扩看的是**连接数,不是 QPS** —— 现在不用做什么,但别用 QPS 去估容量。

**烤进 ExecStart 的可执行路径会随 node 版本管理器变。** 用 nvm / fnm 的人升级 node 之后服务起不来。**但它是响的**(服务启动失败,`status` 会说),不像陈旧的 PATH 那样哑着骗人。

## 测试

**owner 行为**:用户码字符集不含易混字符 · 分组格式 · 在线判定的边界 · 接入请求的四种终态各自互斥 · `kind → 命令名` 清单和数据库 CHECK 一致。

**真实数据库**:

```
同一条接入请求被换两次 → 第二次拒绝,机器只有一台
被拒之后再批 → 拒绝,终态就是终态
过期之后再批 → 拒绝
两台机器同时用一把单次钥匙 → 一台成功,一台明确失败
机器凭据被撤销后报到 → 拒绝,并且说清是被移除了
```

**浏览器旅程**:

```
空 Space 说清 agent 跑在你的机器上,并给出命令
输错码 / 过期码 / 已用过的码 → 三种各自说自己那句
批准之后机器出现,带着它的 agent 和版本
关掉命令 → 转离线,不是消失
一个 agent 都没有的机器 → 说清缺什么,不说"没接上"
```

**跨层**:机器凭据拿去调 `/me` → 401;人的会话拿去报到 → 401。**两种 401 各测一次**,因为它们是两个中间件,写错任何一个都会让另一种凭据穿过去。
