# 对一个 agent 说话 —— 技术方案

对应 `prd.md`。只写这一片要建的东西。

## 两件不同的事

这一片最容易混的就是这两件,先分开:

```
① 一段对话        人说的、它说的、它做的 —— 这是产品的记录,落我们的表
② 它正在干什么    翻译过的实时流,给正在看的人 —— 不落表
```

**① 的表结构不用我们发明,已经有接近标准的答案**(见「数据」)。
**② 不需要任何 schema**:实时那一路只是把同样的翻译推出去,过完就没了。

而 agent 自己写的那份会话文件是**第三样东西** —— 不是①也不是②,是我们崩溃之后
唯一能查明真相的凭据(见决定④)。

两件事共用一个翻译:adapter 把某个 agent 的话翻成我们的词,**一次翻译,两个出口** ——
推给正在看的人,以及写进表。所以不存在两份会走偏的记录。

## owner

| owner          | 拥有                       | 恢复错误                                    |
| -------------- | -------------------------- | ------------------------------------------- |
| `conversation` | 一段对话、里面的消息、三态 | 机器不在线 / agent 不在了 / 接不上 / 不知道 |

adapter 是**边界**,住在常驻进程里,不是 owner。

## 加一个 agent 要做什么

```
① 写一个文件    apps/cli/src/agents/<kind>.ts          驱动它 + 把它的话翻成人话
② 注册表加一行  apps/cli/src/agents/known-agents.ts    kind → adapter
③ 服务端一行    apps/server/src/machine/agent-kind.ts     kind → 要在 PATH 上找的命令
④ 一条迁移      agents_kind_check 加这个 kind
⑤ 页面一行      apps/web/features/agents.ts            它在屏幕上怎么写
```

**五处,其中三处是机械强制的:**③ 少了它,机器报上来的东西被当作不认识直接丢掉;④ 少了它,
写库时被 CHECK 拒;⑤ 少了它,`satisfies Record<AgentKind, string>` 编译不过。

**曾经这一节写的是「两件事,没有第三件」,那是假的。** 少写的三处里有两处不会立刻报错——
一个新 adapter 能跑完整个 turn,然后在写库那一步被拒。写一句好听的承诺,代价是下一个人来调这个。

不用碰的是真的:**序号、幂等、三态、SSE、页面怎么渲染一条工具调用**,adapter 一个都不知道。

### 契约

`apps/cli/src/agents/agent.ts`。**这里不抄一份。** 一份抄件只会和真的那份分头演化 ——
它上一次就是这么错的:抄件里的 `Agent` 有个不存在的 `kind`,`say()` 的参数是三年前的形状,
`stop()` 整个漏了,`ok` 抄成了必填。

只说类型说不出来的那部分:

**adapter 只做翻译和驱动。** 不认识数据库、不认识 HTTP、不知道自己是第几轮。它唯一被允许
自己判断的事是「我这个 agent 说的这句话,是不是『我不记得那个会话了』」——只有它认得自己
那个 SDK 的拒绝长什么样,而认错了就是让人去找一个根本不存在的故障。

**哪些 `Said` 落库由类型保证:** `thinking` 和 `doing` 是给正在看的人的,`text`、`did`、
`trouble` 才是记录。**日志一行写下去不改**,所以一次工具调用是**做完之后的那一行**,不是
「先插一行再回来补结果」——Postgres 每 update 一次就多留一个旧版本,而一次 turn 有几十次调用。

**这一节有检查器**:`apps/cli/agent-check/journey.agents.spec.ts` 对**注册表里的每一个** agent
跑同一套断言,跑真的二进制。加一行注册就自动获得整套测试。

## 数据

**两张表。** 这不是我们设计的,是三家独立收敛出来的形状:

```
AG-UI              一个扁平的 Message[],用 role 区分
                   role: user | assistant | tool | reasoning | activity | system | developer
Vercel ai-chatbot  Chat + Message_v2(id, chatId, role varchar, parts json, createdAt)
OpenAI Responses   Conversation + Items
```

**说清楚从哪儿抄了什么,免得以后有人去对源码时对不上:**

```
扁平的一张消息表,用 role 区分      AG-UI 的 Message[]
role 用普通字符串,内容一个 JSON 列  Vercel 的 Message_v2
activity 这个开放的槽              AG-UI 的 role,但用法不同 —— 见决定⑥
一轮的收尾落成一行                 Multica,不是 AG-UI

没抄的:AG-UI 的 EventType 枚举(TEXT_MESSAGE_START / TOOL_CALL_START / RUN_STARTED …)。
那是**传输协议**,全是 start/content/end 三连;它的持久模型是 MESSAGES_SNAPSHOT,
也就是上面那个 Message[]。我们的传输是 SSE,不需要照搬另一套线上词汇。
```

```
conversations
  id · space_id · machine_id · agent_kind
  agent_session_id(可空)   ← agent 自己报的 id。既用来接上,也是找它那份会话文件的钥匙
  title · created_at

messages                    一条一行,写下去再也不改
  id · conversation_id · seq
  key                       写的人给的确定性名字。迟到的写者在 SQL 里失败
  role                      user | assistant | tool | activity
  content jsonb             per-role 的 zod schema,不是自由 jsonb
  created_at
  唯一(conversation_id, seq) · 唯一(conversation_id, key)
```

`content` 按 role:

```
user       { text }
assistant  { text }
tool       { name, verb, arg, ok, excerpt }      ← 已经是人话了,不是原始参数
activity   { activityType, ... }                 ← 开放的槽,不认识的东西落这儿
```

**不建**:`conversations.status`(派生)· `cwd` 列 · `turns` 表(Codex SDK 有,我们没有)·
`state` 列 · `updated_at`(写一次,不改)· 每个 token 一行 · 工具输出全文 ·
**`role` 里没有 `reasoning`**。

## 决定

**① 用两家的官方 SDK,不用 ACP**

```
@anthropic-ai/claude-agent-sdk   pathToClaudeCodeExecutable → 用户自己装的那个
@openai/codex-sdk                codexPathOverride          → 同上
```

两个都实测跑通了,驱动的是机器上已装的二进制,**登录态和订阅全走用户自己的 CLI,我们不碰任何 key**。
上一片扫 PATH 得到的路径直接喂进去,发现逻辑一行不动。

不用 ACP 不是因为它不好,是**它的价值在长尾,而我们只接两个头部**。实测对比:

```
                 ACP                              官方 SDK
一段说完了       messageId 可选,claude 不发        content_block_stop / ItemCompleted
工具调用         同一个 id 发两次 + 稀疏补丁        一条,状态往前推
装配好的消息     没有                              有
思考             没测到                            claude 的 thinking block,测到了
用量             可选                              每条都有
```

Multica 驱动 20 个 agent 也是这么分的:**claude 和 codex 走原生,其余十一个走 ACP。**
要接长尾时,ACP 是**第三个** adapter,不是唯一那个。

**② 一条消息一行,append-only,写下去不改**

五个系统查下来**没有一个更新行**:dsh 的 JSONL、pi 的 `entries`、OpenHands 的一事件一文件、
Multica 的 `task_message`、Codex 的 rollout。Vercel 的模板是在 `onFinish` 落一次。

会炸的是 UPDATE 不是行数。一条流式文本 200ms 更新一次跑 30 秒 = 150 次 UPDATE,
Postgres 是 MVCC —— 150 个死元组,`content` 进了 TOAST 还要连着 churn。
**行数反而不是问题**:一次重活几十行,一段对话几百行。

所以流式只走 SSE,**一条说完了才落库一行**。

**③ 「它做了什么」落表的是翻译过的一行,不是原始调用**

```
tool  { name: 'Read', verb: '读', arg: 'payment/timeout.ts', ok: true, excerpt: '…' }
```

不落:完整参数、完整输出、原始 JSON。**页面拿到就能画,不需要再认识任何 agent 的格式。**

`verb` 是给认识的工具的礼遇,不是枚举 —— 不认识的 `name` 原样显示(MCP 的
`mcp__linear__create_issue` 就显示这个)。**加一个工具不改库、不改迁移、不改任何清单。**

**④ 崩溃之后不去读 agent 的记录,只说不知道**

`kill -9` 常驻进程之后,实测 agent **不会跟着死**:

```
kill -9 常驻进程
claude 子进程照跑,它的 jsonl 继续长:  12 → 14 → 17 行
```

所以「我们死了而它还活着」是真实状态。诱人的做法是回来之后读它那份记录、把漏掉的补上 —— 我们
写过,然后删了。理由是**它的记录里没有「我们这一轮」的边界**:从哪一行起是我们漏掉的只能猜,
而猜出来补进去的行,会让一段记录看起来完整、其实是编的。**那比缺一段更糟。**

换成一件只有机器自己知道、因此可以由它说的事:

```
机器第一次报到时说「我刚起来」      只有它知道,服务端猜不出来
服务端把它遗留的、开着的轮次收成 unknown
```

**那一刻开着的轮次一定是没人管的** —— 上一个进程已经不在,而这个进程还什么都没接。

**`unknown` 而不是 `failed`。** 两者对人的要求不同:failed 的意思是「再问一遍是安全的」,而这一轮
可能已经把活全干完了。一条 SQL 一次收完所有,因为一台机器可以留下不止一个。

**留给以后的口子,连同它的代价一起记下**:想真的看到它当时干了什么,就得读 agent 自己的记录
(claude 的 `getSessionMessages(session)` 按 id 就能拿到;codex 的 rollout 文件名带创建时间戳,
只能按 id 去 glob)。触发条件是**有人真的因为看不到那一段而做错了决定** —— 在那之前,
「不知道」是诚实的,而补出来的完整是假的。

**④' 异常不越过 adapter 的边界,而且 `cancelled` 不靠异常来认**

两个 SDK **报告任何麻烦的方式都是抛异常**,实测:

```
中途 abort        claude 抛 "Claude Code process aborted by user"     codex 抛 AbortError
resume 接不上     claude 抛 "No conversation found with session ID: …"
模型名不对        codex 抛 Error,message 是一坨 {"type":"error","status":400,…}
```

三条规矩:

**一、`say()` 只产出 `Told`,不抛。** 异常在 adapter 里被接住、翻成 `ended`。上层没有 try/catch。

**二、`cancelled` 的判据是「我们问过没有」,不是异常,也不是 abort 标志。**

```
claude 抛出来的     类名 ir(压缩过的),而 e.name 干脆就是 "Error"
codex 抛出来的      AbortError —— 但被打断的 codex 根本不抛 abort,它是收到信号退出的
```

`instanceof` 靠不住,`e.name` 靠不住,匹配 message 文本更靠不住,**而 `signal.aborted` 也只
在「我们是靠 abort 停的」那条路上才为真**。攥在手里的那件事只有一个:**是不是有人按了停止。**

**两家的停法不是一回事,这是实测出来的,不是设计出来的:**

```
claude   interrupt() —— 官方的控制请求。它自己收掉在跑的东西,而且会回话说接没接受
codex    没有这种东西。SDK 的 abort 是 spawn({signal}),等于 SIGTERM
```

**而 SIGTERM 杀不掉 codex 起的那条命令。** 实测:一个写 60 次的 shell 循环,turn 被记成
cancelled 之后,它把 60 次写完了。SIGTERM 把 codex 本身干掉了,它来不及收自己的子进程。

```
kill -INT <codex>    循环当场停在第 4 行,13 秒后还是 4 行
kill -TERM <codex>   codex 没了,循环继续:5 秒后 8 行,13 秒后 16 行
```

**所以 codex 的 stop 是先 SIGINT 那个进程,而不是 abort。** SIGINT 就是 Ctrl-C 送的那个信号,
codex 会把它传给正在跑的命令。abort 退成兜底:**只在压根没找到进程可打断的时候用**——
先 SIGINT 再立刻 abort 等于没打断,后到的 SIGTERM 会把还在收尾的 codex 直接干掉。

进程得去找:SDK 自己 spawn 了 codex 却不把句柄交出来,所以按「我们的直接子进程 + 命令行里
带着 SDK 那个 `--experimental-json`」去认。这样认不到给模型列表用的 `app-server`。

**三、「接不上」是 `forgot`,不是 `failed`。** 只有 adapter 认得出自己那家的拒绝长什么样
(claude 是 "No conversation found with session ID"),所以这个判断只能在它那儿做。
判错的后果不对称:**把接不上说成失败,人会以为出了故障;说成接不上,人只是知道它忘了。**

**⑤ 思考:实时看得见,永不落库**

`Said` 里有 `thinking`,但**写库的地方不接受它**,由类型保证,不靠记性。

理由不只是省地方:**Claude Code 自己写进 jsonl 的 thinking 块是空的,只留 1336 字节的签名**
(签名是回传 API 用的)。它自己都不留可读的思考。而我们不是那个循环,永远不需要把 thinking
喂回模型。

**⑥ 一轮的开合是两条消息,不是一张表**

一轮以一条 `user` 消息开始,以一条 `activity` 消息结束:

```
{ activityType: 'done' }
{ activityType: 'failed',    why: '…' }
{ activityType: 'cancelled' }
{ activityType: 'unknown' }
```

所以「它还在答吗」是**派生**的:

```
最后一条不是终止 activity  +  机器在线      →  在答
最后一条不是终止 activity  +  机器离线      →  不知道
最后一条是终止 activity                     →  空闲
```

不存 `status`:存了就要在崩溃时去改它,而崩溃改不掉 —— 上一片不存 `machines.status` 是同一条理由。

**这一步是我们自己拼的,不是照抄,所以说清楚:** AG-UI 有 `activity` 这个 role 和自由的
`activityType`,但它实际用来装 agent 产的 UI 内容(`"PLAN"`、`"mcp-apps"`);
**它对「这一轮怎么结束的」的答案是 `RUN_FINISHED` / `RUN_ERROR`,那是 wire 事件,不落库。**

落成一行的做法来自 Multica —— 他们为「这一轮结束了但一个字都没回」专门加了
`message_kind = 'no_response'`,并且在注释里写明**轮次边界不能靠「有没有一条助手消息」来推断**。
OpenAI 的 Responses 也把结局持久化在 Response 上(`status: completed | failed | incomplete`)。
**三家都认为轮次结局值得留档,只是挂的地方不同;我们挂在一行消息上,因为我们没有轮次表。**

`activityType` **没有 CHECK**。这条抄 Multica 的原话:

> Additive and app-validated: no CHECK constraint / FK / cascade so new kinds can be introduced
> without a migration and **unknown values degrade to 'message' on older readers**.

`role` 有 CHECK —— 它是我们自己的四个值。**别人的词汇不设约束,我们自己的词汇才由我们裁决。**

**⑦ 目录不是人给的,是 `connect` 那一刻的位置,而且不进表**

`talk(where, …)` 的 `where` 就是常驻进程自己的 `process.cwd()`。

上一片已经为 PATH 做过这个判断,理由一字不改地适用:

> 编辑器是从 Finder 双击起来的,永远没有「用户刚在终端里敲过命令」那一刻,所以它只能去问 shell。
> **我们有那一刻。**

`handover connect` 跑在哪个目录,那个目录就写进 plist / unit 的工作目录。**产品里不出现「目录」
这个控件,库里也没有这一列** —— 它是那台机器的属性,不是那段对话的。

**一台机器一次只跑一段对话**,由数据库裁决:领活的时候用一句条件更新 ——
这台机器上已经有一轮没收尾就不领。**这不是排期策略,是防覆盖** ——
两个 agent 同一个 cwd 同时改文件就是数据损坏。

**隔离不在这一片,而且理由不是「以后再说」:** 隔离要解决的是「人不在场 + 好几件并行」,
那是「交办」那一片的问题。人在场看着它、就在自己项目里改东西的时候,隔离反而是错的 ——
一个空目录里 agent 什么都读不到。

形状已经清楚了,Multica 就是这么分的:

```
chat_session.work_dir           一段对话一个工作目录,就地改
disposable task worktree        一个 task 一个一次性 worktree,跑完拆掉,持久目录重新成为权威
project_resource 两种模式        in_place / worktree
```

**给 sandbox 和 worktree 留的口子是收口,不是建表**:全代码里只有一个地方产出 `where`。
等第二种真的出现(一个 task 一个目录),它才从代码搬进库里,而那时才知道它该长什么样。

**⑧ `unknown` 不在 adapter 的词汇里**

`Why` 只有 `done | cancelled | failed` —— **adapter 永远说不出 `unknown`**,因为它能说话就说明它还活着。

dsh 把同一条写死在类型上:

> `interrupted`: A persistence backend closed a crash-orphaned turn on reload.
> **The loop never emits this marker.**

我们分两条:

```
页面上    什么都不写。没有终止 activity + 机器离线 = 显示「不知道」,纯派生
机器回来  常驻进程发现有一轮是它自己没收尾的
          → 先按④去读 agent 那份文件。读到了就照实收尾(done / failed),并把漏掉的补进来
          → 文件没了、读不出来、或者那一轮在它那儿也没收尾 → 才是 unknown
```

**先查证,查不出来才说不知道。** 直接判 `unknown` 是把举证责任反过来:
一次崩溃里 agent 多半已经把活干完了,凭空丢掉是不诚实的。

**`unknown` 永不被猜成成功或失败,永不自动重发。** 再说一遍必须由人点。

**⑨ 接不上要说出来,而且是我们说,不是让 agent 自己圆**

`talk(where, sofar)` 里 `sofar` 是上次的 `agent_session_id`。接不上就是接不上:adapter 报一条
`{ told: 'forgot' }`,上层据此落一条 `activity { activityType: 'forgot' }`,**排在这一轮的第一条消息之前**。
不做「把历史重灌一遍假装接上了」。

实测两家 resume 成功之后 **session id 不变**,所以接上了就什么都不用改。

Multica 为这件事专门加了一个字段,注释值得抄:

> The caller owns the wording because only it knows what the surface lost — an issue's comments and
> a Slack channel's history survive and can be re-read, a web chat's and a Feishu channel's cannot.

我们的界面是网页,**历史在页面上还在**,所以说的是「它不记得了」,不是「内容没了」。

**⑩ 幂等由唯一索引兜**

`seq` 由服务器在事务里算,**写的人不猜顺序**。

幂等靠 `key` —— 每条消息在这段对话里的确定性名字。网页用它自己的幂等键,机器算得出
(`t3/said`、`t3/tool/abc`)。**两条写入路径同一条规则:响应丢了重试,第二次在 SQL 里失败**,
所以「不会说两遍」是索引保证的,不是代码记得。

**一轮没收尾的时候不接第二句**(`prd.md` 的「它还在答」)。

**⑪ 派活复用上一片的长轮询,不新开端点**

上一片的返回值里本来就留了位置:

> 这么设计是为了让下一片**往返回值里加东西,而不是删掉一个端点再加一个**。

现在它返回一件活:哪段对话、哪个 agent、要接哪个 agent session、这一轮说什么。

## 三态出现在哪

**这一片是 `architecture.md` §4 第一次被真正检验。** 上一片说过要等的就是这里。

```
succeeded   activityType = 'done'      它明确做完了这一轮
failed      activityType = 'failed'    起不来、明确报错、被卸载。再说一遍是安全的
unknown     activityType = 'unknown'   查证之后仍然说不清它那边做到哪了
```

`unknown` 是**查证失败之后**的结论,不是「没看见就算」—— 崩溃回来先读 agent 那份文件(决定⑧)。

**SDK 报了成功而我们写库失败,那一轮是 `unknown`,不是 `succeeded`。**

**`cancelled` 不是失败**,那是人主动停的,单独一种,不进三态。

## 接口

```
POST   /spaces/{slug}/conversations              挑一台机器上的一个 agent → 一段对话
GET    /spaces/{slug}/conversations              列表。在答没答是算出来的
GET    /conversations/{id}                       对话 + 消息,按 seq
POST   /conversations/{id}/messages              幂等键;说一句
GET    /conversations/{id}/live                  SSE。翻译过的实时流,不是真相
POST   /machines/current/conversations/{id}/live  机器把同一份翻译推出去,不落表

POST   /machines/current/poll                    (上一片)返回值里多了一件活
POST   /machines/current/conversations/{id}/messages   机器追加一条
```

`/machines/current/…` 用机器凭据,`/conversations/…` 用人的会话。**两种 401 各一个中间件**,
和上一片同一条。机器只能写它自己那段对话:`machine_id` 从凭据来,不从路径来。

**契约从路由本身导出**,zod 是真相,OpenAPI 是产物。

**实时那一路跨实例走 Postgres 的 `NOTIFY`。** 机器 POST 到哪个实例、浏览器挂在哪个实例上,
在一个机群里通常不是同一个进程,而一个进程内存里的东西到不了另一个。Postgres 本来就站在
所有实例中间、本来就是这套系统信任的东西 —— 不用多跑一件基础设施,也没有第二份状态要同步。
它**故意**不是 transcript:没人在听的通知就是没了,而这正是「只在发生的时候才值钱」的东西
该有的样子。超过 8000 字节 Postgres 会拒绝,所以长文本是**截断**而不是丢弃 —— 看的是一轮
正在跑,而同样这句话的定稿版本本来就在去 transcript 的路上。

## 风险

**实时和事后不一致,而且是设计如此。** 思考没了、输出截断了。**所以页面要提前说**,
不能让人以为是丢了 —— `prd.md` ⑤ 那张对照表就是为这条写的。

**「不知道」会比人以为的多。** 常驻进程每崩一次,当时开着的那一轮就多一条 `unknown`,而它可能
其实做完了。这是④用诚实换来的,不是缺陷 —— 但如果有人开始因为看不到那一段而做错决定,
那就是④里那个口子的触发条件到了。

**会话文件可能很大。** 一个长会话实测 36 MB / 17571 行。**只能从尾部接,不能读全量。**

**横死会留下孤儿,有序停止不会。** 这一对实测过:

```
有序停止       活儿真的停了,子进程和它起的 shell 一起收掉
              —— 但两家要用不同的手段才做得到这件事,见④'二
kill -9 我们   agent 变孤儿,继续跑、继续花钱、继续写它自己的记录
```

所以常驻进程**收到 SIGTERM 必须 abort 掉在飞的那一轮**再退 —— 上一片已经为「干净停止」
铺过这条线(把 `AbortSignal` 一路传下去),这一片是它第一个真正的用处。

`kill -9` 那种收不住,这一片也不做「收养或收摊」:重连之后能靠④认出那一轮,
**没认出来的就成了没人管的进程**。触发条件是「有人真的被它烧到了」。

**一台机器只有一个目录。** 想在两个项目里各开一段对话,今天要连两次。触发条件是「有人真的要」,
那时做的是⑦留的口子。

## 测试

**共享旅程测试** `apps/cli/agent-check/journey.agents.spec.ts` —— 注册表里每个 agent 跑同一套,
**跑真的二进制,不用假 agent**:

```
一句话跑完 → 它报了会话名、答了话、收尾是 done
跑一条命令 → 一条 did,verb 是人话,ok 是真的
第二句记得第一句(把上一轮的会话名递回去)
递一个它没有的会话名 → told:'forgot' 而不是 failed,然后从零答完
中途叫停 → cancelled 不是 failed,而且活儿真的停了
          (一条每秒写一行的循环,turn 结束后 4 秒再看,一行都没多)
```

**它需要两个二进制都装着且登录着,还要花真的模型调用**,所以不在 `pnpm check` 里,
用 `pnpm test:agents` 单独点名跑。**二进制不在就红,不是跳过** —— 一个因为没跑而绿的测试
比红的更糟。

**没进这一套的两条,以及为什么:**

```
没见过的工具名 → 原样显示    真 agent 逼不出来。改成对着翻译函数的确定性单测:
                            claude-code.spec.ts / codex.spec.ts,各一条
adapter 从不说 unknown       这条由类型保证:Why 里根本没有 unknown 这个成员,
                            测试测不出「不可能被表达的东西」
```

**owner 行为**:一轮开合的配对 · 没收尾 + 离线 = 不知道的判定边界 · 四种收尾 activityType 互斥 ·
per-role 的 content schema 校验。

**真实数据库**:

```
同一句话 POST 两次(同一个幂等键)→ 只落一条
一轮没收尾的时候再说一句 → 拒绝,并说清它还在答
机器 A 的凭据往机器 B 的对话里写 → 拒绝
塞一个没见过的 activityType → 存得进去,读得出来,页面不炸
```

**真实 agent**(claude-code 和 codex 各一遍,跑真的二进制):

```
杀掉 agent 进程 → failed,说清死在哪
杀掉常驻进程再拉起来 → 那一轮收成 unknown,而没人开始的问题仍然在等
```

**浏览器旅程**:

```
挑一个在线 agent,说一句,一件一件出来
说到一半刷新 → 已经落库的都在;实时那一路重新接上
关掉浏览器再回来 → 说的和做的都在,思考没有(页面说清了)
机器离线 → 那一轮显示「不知道」,页面上没有任何自动重发的入口
卸载 agent 之后再说话 → 明确说这台机器上没有它了
```
