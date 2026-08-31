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
  id · machine_name(钥匙那条路上为空,由机器自报)
  secret_hash 唯一          ← 命令行轮询时出示的东西,只存哈希
  user_code   唯一(可空)     ← 给人看的短码;网页生成的那条路没有
  approved_by → users(可空) · approved_at(可空)
  replaces_machine_id → machines(可空)
                              ← 人明确选择重新连接哪个身份;绝不从名字猜
  approved_space_id → spaces(可空)
                              ← 从一个 Space 的 Add machine 发起时,收取凭据后原子加到那里
  refused_at(可空)          ← 被拒绝和从没批过是两件事
  claimed_at(可空)          ← 已经换成机器了,不能再换第二次
  expires_at
  一行 = 一次接入请求。批没批,看 approved_at

machines
  id · owner_user_id · name      ← Account 里的机器身份;属于连它的那个人
  token_hash 唯一           ← 长期凭据,同样只存哈希
  enrolled_from → enrolments
  last_seen_at              ← 在线与否读的时候算,不存状态
  left_at(可空)             ← 主动说的再见。和「静默超时」不是一回事
  version(可空)             ← 它自己报的 build。空 = 它没说,不是缺值
  removed_at(可空)
  created_at

agents
  machine_id · kind · version · models(可空) · found_at · 唯一(machine_id, kind)
  一台机器上扫到的东西。没有状态列:机器离线,它上面的 agent 就都不可用

agent_settings
  machine_id · kind · name · at_once · decided_at · 唯一(machine_id, kind)
  主人给一个安装的全局设置。独立于发现事实,所以一次没扫到不会把人的决定删掉

space_machines
  space_id · machine_id · added_by · created_at · removed_at(可空)
  唯一(space_id, machine_id)
  一行 = 这个 Space 是否可以使用这台机器;移除保留历史,重新添加清掉 removed_at

Conversation 的 `(space_id, machine_id)` 复合外键指向这张表。新 Conversation、派发和机器写回都锁住
当前 active 关系再继续;移除拿同一行锁,所以两边只能有一个先提交。历史 Conversation 仍可读,但关系移除后
不会再开始或写入一轮。
```

**不建**:`machines.status`(派生)· agent 的 `last_seen_at`(跟机器走)· 机器分组 · 能力表。

### 为什么接入请求和机器凭据是两条命

一把钥匙可能被贴到十台服务器上。泄露一把钥匙不该等于泄露十台机器的长期凭据,而且撤销一台机器不该连累另外九台。GitHub(1 小时注册 token → 长期 runner 凭据)和 Tailscale(auth key → node key)都这么分。

### 为什么重新连接必须由人选旧身份

正常重启只读回原来的机器凭据,所以一直是同一个 `machines.id`。真正麻烦的是凭据文件丢失:新进程无法证明
自己就是库里的哪一行。主机名不能代替证明 —— 两台机器可以同名,而且 PRD 明确允许。

因此批准页只把**当前这个人名下、同名、尚未移除**的机器列为候选,由人二选一:

- 不选候选:照旧插入一行新机器
- 选中一行:把新 token 和本次 `enrolled_from` 写回那行,保留 machine id、Conversation、agent 名称与设置;
  同一个事务把它先记为离线,等新进程第一次报到再回来

选择落在 `enrolments.replaces_machine_id`,而不是只停在浏览器请求里。批准和机器收取凭据隔着一次轮询;不把
决定存进接入请求,收取时就只能再猜一次。批准时验证候选属于批准者、未移除且名字相同;收取仍按统一锁序
`enrolments → machines`,轮换 token 后旧进程下一次报到立即失去身份。同一台 machine 同时只保留一条尚未
收取的 replacement;新的批准在 machine 锁下清掉已经过期的占位,仍有效的冲突明确返回不能替换。

不能静默“同名就替换”,也不能只在 Chat 隐藏离线副本。前者会断开一台真的同名机器,后者让旧 Conversation
继续绑在没人能接回来的 machine id 上,都只是把错误藏起来。

### 为什么只有 `last_seen_at`

存 `status` 就得在关机时去改它,而进程被 `kill -9` 改不掉,于是库里会留下一台"在线"的死机器。`last_seen_at` 加一个读时阈值不会和事实不一致 —— **这是 `architecture.md` 那条「派生而非存储」在这一片的具体形态。**

## 决定

**① 机器不选 Space,批准的人选;名字反过来,只有机器自己知道**

`POST /enrolments` 不要会话 —— 一台还没被批准的机器没有任何身份可言。正因为如此,它**不能**报自己
要进哪个 Space:那会让一个没登录的人拿 slug 挨个试,从 201 还是 404 里读出哪个 Space 存在,而
`prd.md` 01 的承诺 ⑥ 说的是**不存在和不是成员,同一个回答**。

**批准首先只回答「这是不是你的」;是否加到当前 Space 是浏览器的明确意图。** 从 Account 连接时,
`approved_space_id` 为空,机器只出现在 Your machines。从 Acme 的 Add machine 发起时,浏览器在批准动作上
带 Acme;CLI 仍然不知道 Space、也不能枚举 Space。收取凭据的事务创建或重连机器后,同时 upsert Acme 的
`space_machines`。

已经连接的机器不必重跑 CLI。`PUT /spaces/{slug}/machines/{id}` 只在调用者仍是成员、机器仍归他时恢复
或创建关系。成员资格和机器可用性是两个事实:加入 Space 不再偷偷扩大为远程执行授权。

Space 列表只读显式关系:

```sql
from space_machines sm join machines m on m.id = sm.machine_id
where sm.space_id = $1 and sm.removed_at is null and m.removed_at is null
```

移除成员的事务把这个人在该 Space 的 `space_machines.removed_at` 一起写下;重新加入不清它。全局 Disconnect
写 `machines.removed_at`,所有 Space 当场都读不到它。Reconnect 更新同一 machine row,所以关系原样保留。

名字走的是相反的方向。**代码那条路**上它在发起时就有,批准的人看着它点的同意 —— 来的机器叫别的,就
不是他同意的那台。**钥匙那条路**上没有人可看也没什么可看:钥匙生成的时候还不存在哪台机器,所以名字
随收下它的那台一起到,`machine_name` 在那之前为空。

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

**没做限流,这是一个知道的缺口,不是没想到。** 同一份标准把熵和限流写成一对:

> The user code SHOULD have enough entropy that, when combined with rate-limiting and other
> mitigations, a brute-force attack becomes infeasible. It is RECOMMENDED that the server
> rate-limit user code attempts.

`20^8` ≈ 34.5 bit,正好是标准自己举的那个量级 —— 而它举那个量级的**前提**就是有限流。我们
`GET /enrolments/{userCode}` 现在只有一道会话门,没有次数上限。

算一遍这个缺口有多大:码只活 15 分钟,同一时刻真正在等的码是个位数。攻击者得先有一个自己的账号,
然后每猜一次命中概率约 `10 / 2.56e10`;每秒一千次要跑一个月才有一半机会撞上**某一台别人正在接入的
机器**,撞上了才能把它认领到自己名下。是真的,但不是现在最该花钱的地方。

**不建的理由不是「不重要」,是它需要一张新表。** 现有那套限流(`LETTERS_PER_CALLER_PER_HOUR`)
是数 `email_codes` 的行数,而查码这条路什么都不写,没有行可以数。为一条概率 1e-9 的路加一张表、
加一个 owner,不划算。

**重新想它的触发条件:** 这个部署开始接受它不认识的人注册的那天。到那天在这条路上加计数,和
`email_codes` 用同一个 `asked_by` 口径,不要发明第二套。

**⑤ 机器的凭据不是 `credentials` 表里的一行**

那张表是**人**的:一行是一把能打开浏览器那扇门的东西。机器凭据打不开那扇门,人凭据也当不了机器。两张表、两个中间件、两种 401。

四家调研对象无一例外都这么分:Multica 的 `mul_`(人)对 `mcn_`(节点),Coder 的 session key 对 agent token,GitHub 的 PAT 对 runner credentials,Tailscale 的用户登录对 node key。

**⑥ 发现是扫 PATH 对一张写死的清单**

不是插件协议,不是让 agent 自己注册。一张 `kind → 命令名` 的表,`--version` 问一次版本。四家一致。

第一版三个:`claude` · `codex` · `cursor-agent`。**清单是纯数据,住在 owner 里**,加一个 agent 是清单里加一行,不动别的。

主人起的名字不是机器报告的一部分。把它放进 `agents`,下一次完整报告删掉一个暂时没扫到的 agent 时也会删掉名字;让机器上一次 PATH 抖动抹掉人的选择,恢复动作只能是再起一遍。所以名字单独住在 `agent_settings`,按同一个 `machine_id + kind` 在读时合上。没有人起名时,wire projection 用 `machine_id + kind` 稳定抽一个默认名;不写库、不随读取变化,而主人写下的名字永远覆盖它。只有机器主人能写,改名不改变 kind、头像种子或路由身份。

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

**⑧ PATH 在 connect 那一刻取下来,不在运行时去问**

服务不继承 shell 的 PATH。launchd 给的是 `/usr/bin:/bin:/usr/sbin:/sbin`,systemd 给的更少 ——
**而找 agent 就是在 PATH 上找**。在终端里跑得好好的,装成服务之后一个都扫不到,报的还是「这台机器
上没有 agent」,完全指不到真正的原因。这条是真踩过的,不是设想。

两种做法,选后者:

```
运行时问登录 shell    要 -ilc(大多数人的 PATH 在 .zshrc,而那是交互式 shell 才读的)
                     要随机分隔符、要绕开 oh-my-zsh、要超时、要解析
                     失败时的恢复动作是「去改你的 dotfile」—— 那不是一个动作

connect 时取下来      那一刻就在用户自己的终端里,PATH 已经是对的
                     写进 plist / unit,服务直接就有
                     失败时的恢复动作是「重跑 handover connect」
```

**关键是一处不对称:编辑器是从 Finder 双击起来的,永远没有「用户刚在终端里敲过命令」那一刻,所以
它只能去问 shell。我们有那一刻。** pm2 和 brew services 都是取下来的。

代价说清:**它是一张快照。** 把 agent 装到一个新目录里,要重跑 `connect` 才看得见。所以 `connect`
当场就把找到了什么打出来 —— 人还站在那台机器前面,能立刻装、立刻重来:

```
connected as zanedeMacBook-Air.local
found     claude 2.1.231 · codex 0.148.0
```

一个都没有的时候说的是「装一个 X 或 Y,然后重跑这条命令」。**同样的空,到了网页上只是一行
「No agents found」,而那时人已经不在那台机器旁边了。**

**⑨ 一个长轮询的端点,不是一个心跳端点**(已经是这样了,见下)

```
POST /machines/current/poll     挂住约 25 秒
  带上   这台机器扫到的 agent 和版本,以及它自己是哪一版
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

## 这条命令是怎么到那台机器上的

整条旅程从「在那台机器上跑 `handover connect`」开始,所以这条命令怎么过去,和它做了什么一样重要。

**① 主路径是一行装好的脚本,不是 npm**

```
curl -fsSL https://raw.githubusercontent.com/zihanyang-dev/handover/main/apps/cli/install.sh | sh
handover connect
```

理由是 `prd.md` 里那台 `build-server-1`:**服务器上不一定有 node**,而「先装 node」会把一行命令
变成一段我们控制不了的教程。npm 那扇门可以同时开着(这本来就是个 node 仓库),但它是给开发者的
便利,不是主路径。Homebrew 放到以后 —— cask 要签名和公证,而 curl 下来的文件不带 quarantine
标记,不签名也能跑,这个顺序让我们先跑起来。

**装到 `/usr/local/bin`,需要 root 才开口要。** `~/.local/bin` 不要 sudo,但它可能不在 PATH 上——
省下一次密码,换来的是装完了 `handover connect` 找不到,而那正是这一行命令要保证的下一步。

**② 发的是一个自带运行时的可执行文件**

`bun build --compile` 出的单文件,运行起来什么都不需要:mac 62 MB、linux 80 MB。同一份代码用
esbuild 打包只有 1.5 MB,**但那 1.5 MB 要求机器上先有 node** —— 省下的体积正是它要求别人先装的
东西。这也是两个 agent 自己的做法:`claude` 281 MB 单文件,`codex` 205 MB 单文件,用户机器上已经
躺着两个了。

**四个平台在同一台机器上编译**(`darwin-arm64`/`darwin-x64`/`linux-x64`/`linux-arm64`)。bun 能交叉
编译,所以一次 release 是一个 job —— 不会出现一半是这个版本、另一半是上个版本。

**注意这只是 CLI 的分发方式,不是这个仓库的运行时。** 日常开发、测试、检查全部留在 node —— 换掉
它们买到的只有「更快」,而那句话写不出一条失败陈述。

**③ 打了 tag 之后发生什么**

```
apps/cli/scripts/build.ts   四个平台各一个文件,版本号由 HANDOVER_VERSION 写进代码里
.github/workflows/release.yml  tag v* 触发:build → SHA256SUMS → 创建 release
apps/cli/install.sh         认出这台机器 → 下载 → 对校验和 → 装上 → 打印装了哪个版本
```

**版本号是写进二进制的,不是运行时读出来的。** 一个人几个月前下载的文件旁边没有 package.json 可读,
而报告「机器连不上」的第一句话就是它是哪个版本。从源码跑的时候没有 tag 可写,它就说 `from source`,
不编一个号出来。

**校验和不对就不装,也不留下。** 这个程序会去铸一份机器凭据,所以它是什么比它到没到更重要。

**④ 机器每次报到都说自己是哪一版**

上一片报了它找到的 agent 的版本,现在它也报自己的。`machines.version` 为空是一个真状态 ——
「它没说」,也就是这台机器上的 build 比这个字段还老 —— 不是缺值,所以不填默认值,页面上写
`handover · unknown version` 而不是留白。留白会被读成「是最新的」。

**每次报到都带,不是 connect 时说一次。** 一个人可以在两次报到之间重跑安装脚本换掉那个二进制,
而「那台机器现在跑的是哪一版」问的是现在这个进程。

请求里带版本这件事本身是 optional 的,理由和「这个部署不认识的命令直接丢掉」一样:**旧 CLI 撞上
新服务器,结果应该是少一条信息,不是连不上。**

**⑤ 怎么知道有新版:问 GitHub,不问我们自己的服务器**

原来这里写的是「等部署,服务器得先知道最新版是哪一版」。那是错的,而且没有一个像样的产品这么做:

```
gh CLI      问 GitHub Releases 自己,24 小时缓存;非 TTY / CI / 设了环境变量就整个不检查
            只在 stderr 提一句,从不自动装
Tailscale   常驻进程能自己升级,但 opt-in,而且要「活动感知」——有流量或开着 SSH 就推迟
```

服务器要真答这个问题,就得有人在每次发版时去告诉它最新版是几,那是一个我们自己维护、还会答错的
事实,而 GitHub 手里本来就有。**所以问 GitHub,和 `install.sh` 下载的是同一个地方。**

**用那个 302,不用 API。** `/releases/latest` 回一个 `location` 指着 tag:不要 token、不受匿名
API 每小时 60 次的限制、没有 JSON 要解析错。还没发过 release 的仓库会跳到列表页而不是 tag——
那不是错误,是「还没有」,当场就得认出来(实测过,我们仓库现在就是这样)。

**只在 `connect` 里问,常驻循环里一次都不问。** 这是 gh 那条「不是终端就不检查」在我们这里的形状:
`connect` 是唯一有人站在跟前的时刻,而且他能立刻再跑一遍那行安装命令;常驻进程每 25 秒报到一次,
没有人在读它,那句提示只会变成一台自己什么都做不了的机器的日志。

**只提示,不自动装。** 一个正在跑 turn 的进程把自己换掉,就是把那一轮活儿弄丢——而我们连「把在飞的
turn 安全交接」都还没有。Tailscale 做自动更新之前先做了活动感知,顺序是对的。

**问不到就什么都不说。** 连不上 GitHub 的人通常是自己把它挡在外面的;既不欠他一句提示,也不欠他
一句「你是最新的」。

## 三态出现在哪

**这一片没有三态。**

注册和报到都没有"不知道成没成"的外部后果:调用失败就重试,重试是幂等的。三态要等到机器真的去跑一个 agent —— 那是下一片,也是 `architecture.md` §4 第一次被真正检验的地方。

先说清楚,免得这一片做完误以为那条已经验过了。

## 接口

```
POST   /enrolments                       机器发起。不要会话,也不报 Space
                                         → { secret, userCode, verifyUrl,
                                             verifyUrlComplete, pollSeconds, expiresAt }
POST   /enrolments/collect               机器轮询,出示 secret 和自己的名字
                                         → granted(带凭据和该找什么)/ waiting
                                           / refused / expired / spent / no-enrolment

GET    /enrolments/{userCode}            网页给人看:哪台机器在等,以及本人同名的既有机器
POST   /me/machines                      认领:带 userCode;可带 replaceMachineId 和当前 spaceSlug
GET    /me/machines                      Account 的 Your machines,带每台当前可用的 Space 摘要
POST   /me/machine-keys                  生成已批准的接入请求;可由 query 明确当前 Space
POST   /enrolments/{userCode}/refuse     回绝

POST   /machines/current/poll            机器报到,带上扫到的东西、自己的版本,以及
                                         它正在答哪段对话(在答的话)
                                         没活就挂住,最多 25 秒
                                         → { pollSeconds: 0, lookFor, asking?, stopping? }
DELETE /machines/current/session         说再见,立刻转离线
GET    /spaces/{slug}/machines           当前 Space 明确添加的机器
PUT    /spaces/{slug}/machines/{id}      把自己一台既有机器添加到当前 Space
DELETE /spaces/{slug}/machines/{id}      只从当前 Space 移除;主人或 Space owner
PATCH  /me/machines/{id}/agents/{kind}   给自己机器上已发现的 agent 起名,或恢复默认名
DELETE /me/machines/{id}                 全局 Disconnect,凭据和所有 Space 同时失效
```

`/machines/current/…` 用机器自己的凭据,**路径里不带 id** —— 带了就得校验「这个 id 是不是你」,而凭据本来就说明了你是谁。

CLI 的发起和回绝不带 Space。浏览器若从某个 Space 的 Add machine 发起,在批准或生成 key 时明确记录该
Space;CLI 仍不枚举也不选择 Space。Account 发起则只连接到 Your machines。

**契约从路由本身导出**,和上一片一样:zod 是真相,OpenAPI 是产物。

## 服务这部分怎么验

到目前为止每条规则都有检查器,`db/` 和 `identity/` 是 100%。装服务这一块本来是例外 —— 直到发现
**容器里能跑真的 systemd**。

```
docker run --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw ... /sbin/init
```

于是能验的比预想的多得多:

```
生成的 unit          交给 systemd-analyze verify —— 连 ExecStart 指的文件不存在都会挑出来
系统服务             daemon-reload · enable · restart · is-active · is-enabled
再跑一次 connect      MainPID 真的变了 —— enable --now 会让正在跑的那个原样留着
崩了会不会被拉起来    kill -9 掉进程,看 systemd 把它拉回来,NRestarts 涨了
日志                 journalctl -u handover 里真的有
服务在哪个目录跑      readlink /proc/$pid/cwd 就是 connect 当时所在的目录
目录没了会怎样        服务干脆起不来,而不是安静地在 / 里读写别人的文件
用户服务             systemctl --user,不用 root
```

**「崩了会不会被拉起来」尤其重要:那是我们把常驻交给操作系统的全部理由**,现在它有证据,不是一句
承诺。跑在 vitest 的 `service` project 里,和数据库测试一样靠 docker。

**只剩 macOS 一条没有检查器。** 没有容器能跑 launchd(内核不一样)。`plutil -lint` 能验 plist 的
语法,`launchctl bootstrap` 起没起来验不了。

那一条是这个仓库里**唯一一处「有人跑过一次」就是全部证据**的地方。但它恰好是我们每天在用的系统 ——
真正危险的是没人用也没人测的那种,而 Linux 现在两样都有。

## 风险

**长轮询挂住连接。** 一百台机器就是一百个挂起的请求。Node 扛得住,但它决定了以后横向扩看的是**连接数,不是 QPS** —— 现在不用做什么,但别用 QPS 去估容量。

**挂住 25 秒,不是更久。** 缓冲代理对一个挂起的请求大约在 30 秒放弃,而被代理掐掉的那一条,
在服务端看来就是一台不再报到的机器。GitHub 的 runner 挂 50 秒是因为它自己控制两端;我们不。

**停机时把挂着的全部当场答掉,不等它们自然到期。** 排空一个挂了 20 秒的请求就是等那 20 秒,
一次看起来卡住的部署由此而来。答掉,机器立刻再问,落到哪个实例都行。

**哪一种服务由谁在跑决定,不由一个没人传的开关决定。** `sudo handover connect` 是「这台机器,给所有人」
的意思;读成用户服务,写出来的那个由 root 自己的登录会话拥有 —— 在服务器上那个会话永远不开始。
`--system` / `--user` 两个开关都在,但它们是用来推翻默认的,不是用来打开正确行为的。

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
明确重新连接旧机器 → machine id、Conversation、agent 设置不变,旧 token 失效,机器行不增加
同名但选择“另一台” → 新建 machine id,不擅自替换
主人给 agent 起名 → 下一次完整报告不覆盖;别人用同一个 id 改名 → 和不存在一样
```

**浏览器旅程**:

```
空 Space 说清 agent 跑在你的机器上,并给出命令
输错码 / 过期码 / 已用过的码 → 三种各自说自己那句
批准之后机器出现,带着它的 agent 和版本
批准同名机器 → 明确选择重新连接既有身份或作为另一台接入
关掉命令 → 转离线,不是消失
一个 agent 都没有的机器 → 说清缺什么,不说"没接上"
```

**跨层**:机器凭据拿去调 `/me` → 401;人的会话拿去报到 → 401。**两种 401 各测一次**,因为它们是两个中间件,写错任何一个都会让另一种凭据穿过去。
