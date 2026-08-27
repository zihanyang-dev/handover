# Handover 全项目评审：Round 2

评审基线：`71dc1d7937f464c567e2f9e50ba9b1703eeef2f5`。只评审该提交中的内容，不把评审期间出现的未提交改动算进 HEAD。

结论：**未通过**。有 8 条高严重度、9 条中严重度发现，另有 8 个低严重度的测试标题/身体不符。当前实现里有些承诺是对的，但测试允许它们无声退化；另一些文档和用户可见文案已经直接不符合实现或 PRD。

## 发现

### 高

#### H1. “运行时有完整命令输出”的 PRD 承诺没有实现，也没有测试

- **失败陈述**：agent 运行一个输出 10 KiB 的命令时，正在观看的人最多收到约 400 个字符和省略号；不是 PRD 所说的“正在干的时候有完整输出”。把截断进一步缩到 1 个字符，现有网页测试仍会通过。
- **证据**：PRD 明确区分运行时全文和事后节选（`docs/roadmap/03-talking-to-an-agent/prd.md:82-89`）；共享 adapter 在进入协议前就把输出截到 400 字符（`apps/cli/src/agents/agent.ts:129-139`），Codex 的 `aggregated_output` 也走该截断（`apps/cli/src/agents/codex.ts:57-65`）；页面只渲染 `did.excerpt`（`apps/web/features/conversations/conversation.tsx:301-324`）；测试只构造一个字符的 excerpt，甚至没有展开验证它（`apps/web/features/conversations/conversation.spec.tsx:180-191`）。
- **处置**：**升级给人**。决定是兑现“运行时全文”，还是先改公开承诺和协议；决定后增加一个超过 400 字符、区分 live 与 reload 的纵向测试。

#### H2. “收回整个子树”只测了一层；网页测试还声称展示了并不存在的说明

- **失败陈述**：给 `root → child → grandchild` 三层任务，把递归 SQL 退化成只结束 root 和直接 child 时，现有数据库测试仍通过，grandchild 会继续在另一台机器上改文件；同时，当前页面只有 `Take it back`，用户在按下前看不到“它开出去的活也会停”，但名为会显示该说明的测试仍通过。
- **证据**：PRD 要求整棵子树停止（`docs/roadmap/04-handing-something-over/prd.md:147-155`、`docs/roadmap/04-handing-something-over/prd.md:257`）；实现当前确实递归（`apps/server/src/db/task.ts:208-237`），但测试只创建一个直接 child，没有 grandchild（`apps/server/src/db/task.spec.ts:515-535`）；网页测试标题声称“says that takes back what it handed out too”，身体只验证 DELETE 被调用（`apps/web/features/conversations/conversation.spec.tsx:904-920`）；源码注释也说按钮会预先说明，实际可见文字只有 `Take it back`（`apps/web/features/conversations/underway.tsx:123-137`）。
- **处置**：**机械化**。增加三层、每层已领取 turn 的数据库行为测试；网页测试必须断言按钮旁实际可见的级联说明。

#### H3. 跨所有 Space 的 Inbox 只在 mock 里跨 Space

- **失败陈述**：一个人同时属于 `acme` 和 `lab`，两个 Space 各有一件等他回答的任务；若后端查询退化成只查第一个/当前 Space，数据库测试仍通过，网页的两行 mock 测试也仍通过，`lab` 的任务会从产品唯一的刹车里消失。
- **证据**：PRD 把“跨所有 Space”及遗漏后果写成硬承诺（`docs/roadmap/04-handing-something-over/prd.md:78-84`、`docs/roadmap/04-handing-something-over/prd.md:253`）；实现当前没有 Space 入参（`apps/server/src/db/task.ts:518-564`），但数据库 Inbox 测试的 fixture 每次只建一个 Space（`apps/server/src/db/task.spec.ts:48-69`、`apps/server/src/db/task.spec.ts:637-680`）；网页所谓跨 Space 测试只是给 `/me/inbox` mock 两行（`apps/web/features/conversations/inbox.spec.tsx:76-83`），没有经过后端入口（`apps/server/src/server/task-api.ts:216-239`）。
- **处置**：**机械化**。在真实数据库中为同一人创建两个 Space、各一件 waiting root task，经 `/me/inbox` 一次断言两件都在。

#### H4. “被移除前停止正在跑的 agent”测试从未启动 agent

- **失败陈述**：机器收到一个 Claude turn 后被服务端以 401 移除；若真实 adapter 的 `stop()` 调用被删掉，只留下“失败/结束”上报，名为防 orphan 的测试仍通过，而 Claude 子进程会继续改仓库。
- **证据**：测试返回 `agentKind: 'claude-code'`，却把空 adapter 列表传给 `keepCheckingIn`（`apps/cli/src/checking-in.spec.ts:173-210`，尤其 `:206`）；生产代码因此走 `agent === undefined` 的 `cannot` 分支，其 `stop` 是空函数（`apps/cli/src/checking-in.ts:243-275`），测试里的 `stopped` 只表示 messages POST 发生过，不表示 agent 被停掉。
- **处置**：**机械化**。传入一个会阻塞的 fake adapter，记录其 `stop()`，并证明移除响应后先 stop、再等待 done、最后退出。

#### H5. 原子凭据写测试只有两次顺序成功写，原地写实现也能通过

- **失败陈述**：第二次写 `machine.json` 到一半断电；若实现改为直接 `writeFile(path, ...)`，现有测试仍通过，但重启后只剩截断 JSON，已连接机器被读成从未连接。
- **证据**：测试只顺序执行两次成功写，然后看最终 token 和目录清单（`apps/cli/src/store.spec.ts:89-100`）；它没有失败注入、并发读或 rename 边界。当前实现的安全性实际来自同目录临时文件、`sync`、`rename`（`apps/cli/src/store.ts:75-107`），这些步骤删掉不会使该测试变红。
- **处置**：**机械化**。注入文件操作，在临时文件写完/rename 前制造失败，并在该点读取旧路径；断言读到完整旧值且失败后清理临时文件。

#### H6. 代理后 HTTPS 的 `Secure` cookie 规则没有回归保护

- **失败陈述**：配置 origin 是 `https://handover.example`，反向代理转给应用的请求 URL 是 `http://server/...`；若实现改为按请求判断或固定 `secure: false`，所有现有登录测试仍通过，生产 session cookie 会缺少 `Secure`。
- **证据**：设计明确说必须按配置 origin，而不能按请求（`docs/roadmap/01-login-and-space/design.md:141-152`）；当前代码是正确的（`apps/server/src/server/session.ts:22-42`）；但验证码登录测试只用 HTTP `WEB`，只断言 `HttpOnly` 和 `SameSite=Lax`（`apps/server/src/server/sign-in-api.spec.ts:13-17`、`apps/server/src/server/sign-in-api.spec.ts:203-214`），OAuth 测试同样把 origin 和 web 都设成 HTTP（`apps/server/src/server/oauth-api.spec.ts:30-31`）。
- **处置**：**机械化**。以 HTTPS 配置 + HTTP 入站请求分别走验证码和 provider 两条入口，精确断言 `Secure`；再保留 HTTP 配置的非 Secure 对照。

#### H7. `03/design.md` 否认当前权威 ledger 的存在，并要求从 transcript 判断

- **失败陈述**：维护者按设计为新读路径实现“最后一条非终止消息 + 机器在线 = 正在回答”；当对话只有一条尚未被机器领取的 user 消息时，它会被误报为正在回答，虽然 `turns` ledger 中没有 open turn。
- **证据**：设计写“只有两张表”、明确“不建 turns”，并从最后一条消息派生状态（`docs/roadmap/03-talking-to-an-agent/design.md:87-137`、`docs/roadmap/03-talking-to-an-agent/design.md:275-303`）；当前 schema 有 `turns` 表（`apps/server/generated/schema.sql:221-231`），项目评审手册还明确规定判断读 ledger、永不读 transcript（`docs/review.md:79-86`）。
- **处置**：**修**。删除退役的“两表/无 turns/从最后消息派生”方案，按当前 `turns` ledger 重写这一节；文档修正后再补一个“有 user message、无 claimed turn”的读路径测试。

#### H8. 同一份设计对 crash recovery 给出互相相反的指令

- **失败陈述**：机器重启时留下一个 open turn，agent 自己的文件看起来像 done；按设计后半段实现会补写遗漏内容并标 done，而当前策略和测试要求直接记 unknown。于是一次无法证实边界的 crash 会被展示成已证实成功。
- **证据**：前半段明确禁止读 agent 记录并要求启动时报 unknown（`docs/roadmap/03-talking-to-an-agent/design.md:187-215`）；后半段却要求先读文件、能读到就补写并记 done/failed（`docs/roadmap/03-talking-to-an-agent/design.md:343-364`）。当前实现无条件为 stranded turn 追加 unknown 并结束 ledger（`apps/server/src/db/turn.ts:338-376`），相应测试也断言 restart 后 unknown（`apps/server/src/db/conversation.spec.ts:493-508`、`apps/server/src/server/conversation-api.spec.ts:332-353`）。
- **处置**：**修**。删掉 `design.md:352-362` 的退役恢复算法，只保留当前有代码和测试支撑的 unknown 策略。

### 中

#### M1. 首次账号合并提示没有说最早入口，也没有说明入口数量

- **失败陈述**：账号最早由 Google 建立，之后同邮箱的另一入口首次并入；页面只说“you already had an account”，没有告诉用户最早是 Google，也没有让他知道现在有几条路可进账号，现有测试仍通过。
- **证据**：PRD 的一次性提示明确包含最早 provider，并把入口数量列为披露责任（`docs/roadmap/01-login-and-space/prd.md:33-39`）；当前提示是通用句子（`apps/web/features/identity/arrival.tsx:19-28`）；测试只找通用开头（`apps/web/routes/arriving.spec.tsx:34-40`）。HEAD 已保护“选择前同地址同账号”的另一条承诺（`apps/web/features/identity/sign-in.spec.tsx:63-74`），但没有保护这里。
- **处置**：**升级给人**。确认响应需要携带 earliest provider/可用入口的公开协议；先改设计，再让浏览器测试断言具体 provider 与只显示一次。

#### M2. CLI 和接入注释仍在传播已经废弃的“机器属于一个 Space”模型

- **失败陈述**：一个人在 `acme` 和 `lab` 都是成员，运行 `handover --help`、重连或被移除时，会看到“put this machine in a Space”“not in that Space”“taken out of its Space”；他会以为机器要在两个 Space 分别连接，或一把 key 会把机器从一个 Space 移到另一个，和实际的人所有权模型相反。
- **证据**：PRD 规定机器属于人，并自动随全部成员资格可达（`docs/roadmap/02-machines-and-agents/prd.md:121-148`）；用户可见 CLI 和控制流仍写 singular Space/移动语义（`apps/cli/src/main.ts:42-53`、`apps/cli/src/main.ts:133-153`、`apps/cli/src/main.ts:216-228`、`apps/cli/src/main.ts:381-387`）；网页、数据库和 API 顶部注释也还说页面会问 Space/机器进入 Space（`apps/web/features/machines/connect.tsx:1-6`、`apps/server/src/db/enrolment.ts:87-91`、`apps/server/src/server/enrolment-api.ts:1-6`），同文件后文已经写了相反的新规则（`apps/web/features/machines/connect.tsx:35-40`、`apps/server/src/db/enrolment.ts:121-128`）。
- **处置**：**修**。统一为“连接到你的账号/部署；从你所属 Space 可达”，删除“移动 Space”的控制流解释，并为 help、not-ours、removed 三条可见文案加测试。

#### M3. 两处“新增 agent”注释都少报必改位置，另有一处命名不存在的约束

- **失败陈述**：贡献者照 `agent.ts` 的“adapter 文件 + registry 一行”说明加入 Gemini；CLI 侧能编译，但 server 不认识 kind、数据库 CHECK 拒绝或网页缺 label，完整 turn 在后半段失败。
- **证据**：权威设计列出五处，并明确旧的“两处”说法是假话（`docs/roadmap/03-talking-to-an-agent/design.md:50-64`）；`apps/cli/src/agents/agent.ts:3-12` 仍说数据库/API/页面都不用知道，`apps/server/src/machine/agent-kind.ts:1-9` 仍说本表 + migration 后“nothing else”。`apps/server/src/db/machine.ts:319-321` 又把 CHECK 叫作不存在的 `agents_kind_is_one_we_know`，实际约束是 `agents_kind_check`（`apps/server/generated/schema.sql:30-37`，测试也按该名读取：`apps/server/src/db/enrolment.spec.ts:167-177`）。
- **处置**：**修**。各处只链接到拥有完整清单的 design，不复制残缺清单；修正约束名。

#### M4. 设计和七个测试注释仍声称 request key 全局唯一，和修过的隐私边界相反

- **失败陈述**：Alice 和 Mina 都用客户端生成的 `retry-1` 创建各自 Space；当前 schema 应允许两个请求。维护者若按文档恢复全局唯一索引，后一个请求会冲突，甚至重现“读到别人的私有 Space”问题。
- **证据**：设计仍写 `email_codes.request_key` 和 `memberships.request_key` 单列唯一（`docs/roadmap/01-login-and-space/design.md:44-48`、`docs/roadmap/01-login-and-space/design.md:62-65`）；当前迁移解释了全局唯一造成的跨用户隐私错误并改为请求者/请求内容作用域（`apps/server/migrations/20260828090000_a_key_belongs_to_who_asked.sql:1-20`），生成 schema 也是 `(request_key,email,purpose)` 与 `(user_id,request_key)`（`apps/server/generated/schema.sql:302-306`、`apps/server/generated/schema.sql:358-362`）。错误注释仍见 `apps/server/src/server/credential-api.spec.ts:20`、`apps/server/src/db/email-code.spec.ts:26`、`apps/server/src/db/across-instances.spec.ts:37`、`apps/server/src/db/sign-in.spec.ts:23`、`apps/server/src/server/sign-in-api.spec.ts:25`、`apps/server/src/server/oauth-api.spec.ts:22`、`apps/server/src/server/app.spec.ts:15`。
- **处置**：**修 + 机械化**。先修设计和注释；增加两个用户复用同一 key、各自只读到自己结果的回归测试。

#### M5. 三个“使用数据库时钟”的测试都拿进程时钟作裁判

- **失败陈述**：数据库时钟比应用进程快两分钟时，正确的验证码 expiry 测试会失败；反过来，把实现退化为 `Date.now()`，在时钟同步的 CI 上仍会通过。session expiry 和 presence `asOf` 同样不能区分两个时钟。
- **证据**：架构要求权威时间全部来自数据库（`docs/architecture.md:61-66`）；验证码测试用 `row.expires_at - Date.now()`（`apps/server/src/db/email-code.spec.ts:199-206`），session 测试同样用 `Date.now()`（`apps/server/src/db/sign-in.spec.ts:175-187`），machine 测试只断言 `asOf >= lastSeenAt`（`apps/server/src/db/machine.spec.ts:357-369`），进程时钟实现通常也满足。
- **处置**：**机械化**。在同一 SQL statement/transaction 中返回数据库基准时刻和写入时刻，断言二者间隔；不要让测试进程的墙钟参与裁决。

#### M6. hand-off 测试没有创建标题中的两个拒绝场景，也没有重复验证同名稳定性

- **失败陈述**：现存目标机器在另一个 Space，或目标机器可达但没有 Codex；删除 `reachableFrom` 或 agent 查询时，名为覆盖这两种情况的测试仍通过，因为它只请求一个根本不存在的名字。另一个回归若在两个同名机器间按物理顺序漂移，所谓“every time”测试也可能通过，因为它只 hand off 一次。
- **证据**：合并标题的测试没有 attach 任何目标机器，只请求 `somebody-elses-laptop`（`apps/server/src/db/task.spec.ts:498-512`）；实现实际上有独立 `no-machine`/`no-agent` 分支（`apps/server/src/db/conversation.ts:463-512`、`apps/server/src/db/conversation.ts:548-574`）。同名测试创建两台后只调用一次（`apps/server/src/db/task.spec.ts:318-330`），而 PRD 要求“每次都指同一台”（`docs/roadmap/02-machines-and-agents/prd.md:144-148`）。
- **处置**：**机械化**。拆成 existing-but-unreachable、reachable-without-agent、两次同名 hand-off 三个测试，各自断言明确结果和目标 machine id。

#### M7. 不同 request key 抢同一 slug 的断言允许所有 loser 假装 replay

- **失败陈述**：20 个不同 request key 同时创建 `acme`，实现给 1 个 `created`、19 个 `replayed`；当前测试通过，但 19 个用户拿不到 PRD 承诺的 slug conflict 和 `acme-2` 建议。
- **证据**：设计要求不同 key 的 loser 得到冲突与建议（`docs/roadmap/01-login-and-space/design.md:218-227`）；测试却只要求 `slug-taken + replayed = 19`，并用可空集合上的 `every` 检查 suggestion（`apps/server/src/db/space.spec.ts:112-128`）。
- **处置**：**机械化**。精确断言 1 个 `created`、19 个 `slug-taken`，且每个 suggestion 都是 `acme-2`；`replayed` 只应出现在相同 key 的独立测试。

#### M8. Linux 用户服务实测主动开启 linger，无法保护“未登录不随开机启动”

- **失败陈述**：非 root 用户连接笔记本后重启、尚未登录；若安装逻辑错误地开启 linger，让服务开机即运行，当前容器测试仍通过，因为测试 fixture 自己先执行了 `loginctl enable-linger mina`。这正违反“笔记本开机不启动”的 PRD。
- **证据**：PRD 的生命周期表和完成标准要求笔记本重启后离线、登录后回来（`docs/roadmap/02-machines-and-agents/prd.md:72-83`、`docs/roadmap/02-machines-and-agents/prd.md:187-203`）；设计明确禁止 linger（`docs/roadmap/02-machines-and-agents/design.md:147-165`）；容器安装用户服务前却开启 linger，之后只断言 active 和重复安装仍 active（`apps/cli/service-check/service.container.spec.ts:82-104`、`apps/cli/service-check/service.container.spec.ts:223-244`）。
- **处置**：**机械化**。测试未登录/登录/退出登录三个真实 user-manager 边界；fixture 不得用 linger 把用户服务改成 server 语义。

#### M9. 三组测试把固定 sleep 和调度速度当成事件顺序证据

- **失败陈述**：CI 暂停事件循环超过 100 ms 时，正确的 abort 会被判失败；在 `wakeEveryone()` 测试中，请求若 50 ms 后仍未登记，wake 会先发生，请求随后可挂到超时。相反，“消息唤醒长轮询”测试若请求启动慢，写入会先发生，第一次数据库读取直接拿到消息，测试通过却没有走通知唤醒链路。
- **证据**：sleep 测试用真实 20 ms 和 `<100 ms` 墙钟阈值（`apps/cli/src/sleeping.spec.ts:5-34`）；machine API 两个测试用固定 50 ms 猜测请求已被 waiting room 持有（`apps/server/src/server/machine-api.spec.ts:429-459`、`apps/server/src/server/machine-api.spec.ts:474-489`）。
- **处置**：**机械化**。给 waiting room 暴露测试用“已登记”握手/Promise；sleep 用 fake timer 或只断言 abort 解析，不用墙钟上限证明顺序。

### 低：测试标题/身体不符

以下每一项都是一个独立的标题承诺；它们没有上升为更高严重度，是因为核心行为在别处有覆盖，或直接后果限于测试失真。

| 测试                                                            | 标题没有真正构造/断言的东西                                                            | 会漏过的具体回归                                                                                                                         |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/cli/src/checking-in.spec.ts:73-82`                        | “reports what it found, every time”传入空 adapter，只数 3 个 request，不看任何 `found` | 每次 report 都省略 `found`，该测试仍通过                                                                                                 |
| `apps/cli/src/task.spec.ts:131-149`                             | “writing it again replaces it”只 PUT 一次                                              | CLI 第二次改用 POST 或不同 title，测试仍通过；只有 DB 层另一个测试保护 replacement（`apps/server/src/db/task.spec.ts:583-600`）          |
| `apps/web/features/conversations/conversation.spec.tsx:165-178` | “shows what was said, in order”只分别找两个文本，不比较 DOM 顺序                       | 页面把 assistant 放到 user 前面仍通过                                                                                                    |
| `apps/web/features/conversations/conversation.spec.tsx:407-414` | “takes it away once idle”从未把 working fixture 变成 idle                              | Stop 永远留在同一次状态转换后的 DOM 里仍通过；静态 idle 由 `:437-444` 另测                                                               |
| `apps/server/src/server/waiting.spec.ts:103-112`                | “keeps nothing”只断言对过期 machine 调 `wake` 不抛错，不观察内部 entry 是否删除        | waiting room 永久保留每台机器的空 Set，测试仍通过，长跑进程持续增长                                                                      |
| `packages/universal/slug.spec.ts:56-60`                         | “browser and server”实际调用同一个函数两次，只证明近似幂等                             | 浏览器或服务端改成本地副本后产生不同 slug，该测试仍通过                                                                                  |
| `apps/server/src/db/machine.spec.ts:380-386`                    | “id belongs to another Space”创建的是本 Space 自己的机器，再给一个不存在的 owner UUID  | DB owner/Space 边界回归仍可通过该测试；真实同 Space 他人场景只在 HTTP 层另测（`apps/server/src/server/machine-api.spec.ts:305-318`）     |
| `apps/server/src/server/waker.spec.ts:68-72`                    | “comes back with a count”不创建到期任务，只断言结果 `>= 0`                             | `wakeWhoseTimeHasCome` 永远返回 0 的 no-op 实现仍通过；到期任务行为只在 DB 测试另有间接保护（`apps/server/src/db/task.spec.ts:228-249`） |

## 数了什么

- HEAD 中共 75 个 `*.spec.ts` / `*.spec.tsx`，逐文件读了 13,356 行，包含 785 个 `it`/`test` 声明。
- 逐处读了 73 个 `toMatchObject` 和 135 个 `toBeDefined`。除上面列出的部分对象/空泛存在性问题外，其余用于判别 union 分支、HTTP 子集或 DOM 是否出现，与测试标题一致；没有再发现需要报告的弱断言。
- 四份 PRD 共 38 条编号承诺。实质上没有回归保护的是：运行时完整输出、首次合并的具体披露、跨 Space Inbox、递归收回、笔记本/服务器生命周期；均已列入发现。
- `it.only` / `test.only` / `skip` / `todo`：0。
- root 特有事故：**干净**。写权限失败测试特意用“普通文件挡住目录”制造 `ENOTDIR`，root 也绕不过（`apps/cli/src/reachable.spec.ts:54-69`）。
- 平台、sleep、顺序和时钟：不干净，见 M5、M8、M9；没有发现除此之外会因 root 身份改变结论的测试。
- “选择登录方式前说明同地址同账号”在本基线已由 DOM 顺序断言保护（`apps/web/features/identity/sign-in.spec.tsx:63-74`），因此不再作为发现。

## 删除

- 删除 `docs/roadmap/03-talking-to-an-agent/design.md:87-137` 和 `:275-303` 中退役的“无 turns、从 transcript 判断”方案，改由一段当前 ledger 方案取代；同一事实不能保留两个答案。
- 删除 `docs/roadmap/03-talking-to-an-agent/design.md:352-362` 中“先读 agent 文件再猜 done/failed”的退役 crash recovery；它与同文件前文和当前代码相反。
- 删除 `apps/cli/src/agents/agent.ts:10-11`、`apps/server/src/machine/agent-kind.ts:4-9` 中复制且残缺的新增-agent 清单，只保留指向拥有该事实的 design。
- 删除 `apps/server/src/server/waker.spec.ts:68-72` 的恒真计数断言；用带 scoped due task 的行为测试替代。
- 删除七个 spec 顶部“request key 全库/全表唯一”的注释；它们描述的是已经因隐私问题撤销的 schema。

## UNVERIFIED

- `pnpm check` 未能进入任何项目脚本：Corepack 拒绝运行 `pnpm@10.20.0`，因为受限网络下 `@pnpm/exe`、`@pnpm/macos-arm64`、`pnpm` 的 registry signature 无法验证。该命令是全项目审查要求（`docs/review.md:314-319`）和仓库主检查（`docs/repository.md:115`），所以 typecheck/lint/format/test/generate 终态均未验证。
- `pnpm test:agents` 未运行。它要求本机 Claude/Codex 已安装并登录，而且会产生真实模型调用费用（`docs/roadmap/03-talking-to-an-agent/design.md:500-512`、`docs/repository.md:113`）；本次只读评审没有得到执行外部后果的授权。
- macOS launchd 的 bootstrap、重启和登录生命周期未验证。仓库自己说明这里只有 plist 语法和一次人工运行证据（`apps/cli/service-check/service.container.spec.ts:1-10`、`docs/roadmap/02-machines-and-agents/design.md:375-382`）。因此不能把 M8 的 Linux 结论外推成 macOS 已通过或已失败。

## 退出评审

**不满足退出条件。** 上述高严重度发现仍在，`pnpm check` 没有执行成功，真实 agent 旅程和 macOS 常驻旅程也未验证。该报告完成的是 Round 2 的全项目证据清单，不是对 HEAD 的放行。
