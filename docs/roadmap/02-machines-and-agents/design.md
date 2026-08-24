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
  id · space_id · machine_name
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

**① 两条接入路径共用一张表,区别只在建的时候批没批**

```
笔记本  命令行建一行:未批准、有 user_code、secret 只有它自己知道
        → 人在任意设备上批 → approved_at 落下
        → 命令行轮询发现批了 → 拿 secret 换机器凭据 → claimed_at 落下

服务器  人在网页上建一行:approved_at 当场落下、没有 user_code
        → 明文只回一次 → 粘到机器上 → 换机器凭据
```

**auth key 不是另一套机制,是一条已经批过的接入请求。** 这条来自 Tailscale —— 它的 key 属性里就有一个 `pre-approved`。

**② 用设备码,不用本地回调**

本地回调(命令行在 `127.0.0.1` 开个端口等浏览器跳回来)要求**浏览器能连到命令行所在的机器**。命令行在服务器上就连不到,于是要么让用户开 SSH 隧道,要么去猜自己的出口 IP 判断拓扑。

设备码对网络零假设,因为**根本没有回调**:命令行只是拿着自己的 secret 去轮询。

轮询的回答照抄那套标准,因为四种情况都是真的:

```
还没批    接着等
太快了    间隔 +5 秒
过期了    15 分钟,重来
被拒了    终态,不能重试
```

**③ 用户码用 RFC 8628 那个字符集,并且干净网址是主路径**

字符集是 `BCDFGHJKLMNPQRSTVWXZ` —— 大小写不敏感的 A–Z,**去掉全部数字,再去掉元音**。

- 全字母就不存在 `0/O`、`1/I` 认错的问题,不用一条条排除
- **去掉元音是为了不随机拼出单词**,免得给人发一个骂人的码
- 八位 `WDJB-MJHT`,`20^8` ≈ 256 亿

命令行打两行:干净网址加码,以及一个带码的完整网址(标准里的 `verification_uri_complete`,存在的理由是二维码这类"非文本传输")。**能复制就点第二行,拿手机对着服务器屏幕就念第一行。**

**带码的那个是加速通道,不是主路径。** 标准明确不建议把码塞进主网址,理由不是安全是可用性:

> It is NOT RECOMMENDED for authorization servers to include the user code in the `verification_uri`... The rationale emphasizes that **allows users to receive error feedback about code entry after successfully reaching the URI**.

只给带码长网址的话,**输错一个字符得到的是 404,而不是「这个码不对」** —— 页面都到不了,就没地方说哪儿错了。

字符集和分组是纯规则,住在 `machine` owner 里,测试钉住:**不含数字、不含元音、不随机成词。**

**④ 机器的凭据不是 `credentials` 表里的一行**

那张表是**人**的:一行是一把能打开浏览器那扇门的东西。机器凭据打不开那扇门,人凭据也当不了机器。两张表、两个中间件、两种 401。

四家调研对象无一例外都这么分:Multica 的 `mul_`(人)对 `mcn_`(节点),Coder 的 session key 对 agent token,GitHub 的 PAT 对 runner credentials,Tailscale 的用户登录对 node key。

**⑤ 发现是扫 PATH 对一张写死的清单**

不是插件协议,不是让 agent 自己注册。一张 `kind → 命令名` 的表,`--version` 问一次版本。四家一致。

第一版三个:`claude` · `codex` · `cursor-agent`。**清单是纯数据,住在 owner 里**,加一个 agent 是清单里加一行,不动别的。

发现在**每次报到时**做,不只是启动时。别人 `brew upgrade` 之后我们跟着更新版本号,不重启、不重接。

**⑥ 命令行前台跑**

不做 pid 文件、不做 profile 目录、不做日志路径解析。要常驻交给 systemd / launchd。

Multica 那份文档里,"两个 `daemon.log` 你不知道在看哪个"这类问题占了很大篇幅,而**那些复杂度全部来自它自己做了后台化**。

**⑦ 报到是拉取,不是推送**

机器定期报到,服务器在回答里附上"有没有活"。这一片还没有活,但形状先立住:**服务器永远不主动连机器。**

Multica 文档说轮询 3 秒,代码里有 WebSocket,但那个 WebSocket 只送 `wakeup hints` —— **活本身还是机器自己来拿。** 和 `architecture.md` 写的是同一件事。

## 三态出现在哪

**这一片没有三态。**

注册和报到都没有"不知道成没成"的外部后果:调用失败就重试,重试是幂等的。三态要等到机器真的去跑一个 agent —— 那是下一片,也是 `architecture.md` §4 第一次被真正检验的地方。

先说清楚,免得这一片做完误以为那条已经验过了。

## 接口

```
POST   /spaces/{slug}/enrolments        命令行发起
                                        → { userCode, verifyUrl, verifyUrlComplete,
                                            interval, expiresAt }
POST   /enrolments/claim                命令行轮询,出示 secret → 未批 / 过期 / 被拒 / 机器凭据
GET    /enrolments/{userCode}           网页给人看:哪台机器、进哪个 Space
POST   /enrolments/{userCode}/approve   人批准
POST   /enrolments/{userCode}/refuse    人拒绝

POST   /spaces/{slug}/machine-keys      网页生成一条已批准的,明文只回一次

POST   /machines/current/heartbeat      机器报到,带上它扫到的 agent
GET    /spaces/{slug}/machines          Space 页面读这个
DELETE /machines/{id}                   移除
```

`/machines/current/…` 用机器自己的凭据,**路径里不带 id** —— 带了就得校验"这个 id 是不是你",而凭据本来就说明了你是谁。

**契约从路由本身导出**,和上一片一样:zod 是真相,OpenAPI 是产物。

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
