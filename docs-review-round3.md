# Handover 全项目评审 · Round 3

评审对象：`HEAD 71dc1d7937f464c567e2f9e50ba9b1703eeef2f5`。评审期间并发出现、但不属于该
HEAD 的工作区文件没有纳入结论。

本轮只看熵、重复与简约。按 `docs/review.md` §3.4 / §5，先枚举用户动作，再逐表、逐导出、逐
CSS 名称和逐份稳定文档核对。以下发现按严重度排序。

## 发现

1. **严重：接机器仍有两个完整页面；只合并了“取 key”之后，两套状态机已经给出相反的恢复** —
   `apps/web/routes/onboarding_.host.tsx:1`、`apps/web/features/onboarding/onboarding.tsx:321`、
   `apps/web/features/onboarding/host.tsx:21`、`apps/web/features/onboarding/host.tsx:95`、
   `apps/web/features/machines/machines.tsx:18`、`apps/web/features/machines/machines.tsx:197` — 产品 / 简约 / 前端

   触发 A：在 Space 的 Machines 面板点 “Add a machine with no browser”，第一次
   `POST /me/machine-keys` 返回失败，再点文案已经变成 “Try again” 的同一个按钮。按钮只再次执行
   `setAsked(true)`；状态原本已经是 `true`，query 没有 reset/refetch，第二个请求不会发生
   （`apps/web/features/machines/machines.tsx:204`–`:235`）。

   结果 A：页面明确给出一个无效的恢复动作。相同失败在 Host 页面却会
   `resetQueries(MACHINE_KEY)`；过期 key 也只有 Host 页面倒计时、隐藏并重建，Space 面板会继续显示死
   command（`apps/web/features/onboarding/host.tsx:105`–`:174`）。现有 Machines 测试甚至用“现在”作为
   `expiresAt` 后断言旧 key 仍显示，因而固定了错误分支（`apps/web/features/machines/machines.spec.tsx:296`–`:331`）。

   触发 B：新建 Space。已有 Space 的选择直接进 `/s/{slug}`，新建的却进第二个
   `/onboarding/host` 步骤（`apps/web/features/onboarding/onboarding.tsx:336`–`:382`）；这与“零/一/多个
   Space 行为一样、没有第一个特例”以及“空 Space 自己显示 connect 命令”冲突
   （`docs/roadmap/01-login-and-space/prd.md:41`–`:51`、
   `docs/roadmap/02-machines-and-agents/prd.md:13`–`:24`）。视觉简报还把这个产品分支复制成第二份事实
   （`.21st/design.json:94`–`:102`），尽管仓库规则说与 PRD 重叠时 PRD 胜
   （`docs/repository.md:34`–`:37`）。

   **删除 / 合并：**删除 `onboarding_.host.tsx`、`ConnectHost`、`host.spec.tsx`、两段各自的
   `machinesIn`、两步 `Steps` 以及只服务这条旧路径的 `host-*` / `shell-*` / `steps-*` 样式；新建后
   直接进入 `/s/{slug}`。保留一个 Machines surface，并把 Host 已有的 expiry、retry 和连接后刷新行为
   合进去；从 `.21st` 删除“创建后进 Host”的产品规则。代码、路由、设计简报统一叫 `machine`，不再叫
   `host`。

   **不删会坏什么：**同一个 key 在一个入口可重试、在另一个入口按钮无效；过期 key 在一个入口被
   拒绝复制、另一个入口继续诱导人运行；以后每次修机器接入都必须同时记住两套页面。

2. **严重：Space frame/query 实现两份，并且普通 HTTP 失败已经被当成“不属于你”** —
   `apps/web/routes/s.$slug.tsx:10`、`apps/web/routes/s.$slug_.c.$id.tsx:9`、
   `apps/web/features/spaces/home.tsx:117` — 产品 / 简约 / 前端

   触发：打开 `/s/acme` 或 `/s/acme/c/{id}`，`GET /spaces/acme` 返回带 JSON body 的 503。两个
   queryFn 都只取 `data`，再以 `data ?? null` 返回（`apps/web/routes/s.$slug.tsx:12`–`:17`、
   `apps/web/routes/s.$slug_.c.$id.tsx:11`–`:16`）。

   结果：503 成为成功的 `null`，页面显示 “This Space is not available”，把“稍后重试”说成“回你的
   Spaces”。Home 的 `space.isError` 分支对这种 HTTP 失败是死分支；conversation 路由则根本没有 error
   分支。临时行为断言以 503 响应期待 “Could not read this Space”，实际得到 “This Space is not
   available” 并按预期红；HEAD 新增的测试只覆盖 `HttpResponse.error()` 的网络异常，不覆盖 HTTP 失败
   （`apps/web/routes/s.$slug.spec.tsx:84`–`:95`）。

   两个顶层 route 又各自挂一次 `Home`。从 Home 打开 conversation 会卸载 frame，sidebar 的开合与
   270–480px 宽度重新初始化（`apps/web/features/spaces/home.tsx:130`–`:132`），正好违背该文件所写的
   “one frame rather than one per page”（`:4`–`:9`）。

   **删除 / 合并：**把 Space query、pending/error/404 和 `Home` 移到唯一的 `/s/$slug` parent layout；
   Home 与 conversation child 只提供各自内容。删除两个 leaf 中重复的 query、状态页和 frame scaffold，
   并像 `useConversation` 一样只把 404 映射成 `null`。

   **不合并会坏什么：**服务端拒绝与资源不存在继续共用错误恢复；任一路由单独修复仍会留下另一条；
   页面内导航继续丢 sidebar 状态。

3. **严重：验证码同时有“第六位自动提交”和 form submit；五位码可以从第二条路发出去** —
   `apps/web/features/identity/email-code.tsx:152`、`apps/web/features/identity/email-code.tsx:181`、
   `apps/web/features/identity/add-address.tsx:93` — 产品 / 简约 / 测试

   触发：在登录验证码页输入 `49301`，点仍然可用的 “Continue”。`onSubmit` 不检查长度，直接
   `mutate(code)`（`apps/web/features/identity/email-code.tsx:154`–`:159`、`:201`–`:203`）；第六位的
   `onChange` 另有一条自动提交路径（`:181`–`:190`）。绑定邮箱的 `AnswerCode` 同样同时保留自动提交和
   form submit（`apps/web/features/identity/add-address.tsx:113`–`:143`）。

   结果：五位请求到达 `/browser/sessions` 并显示一次本不该发生的失败。临时测试用这组输入断言
   `handed === false`，实际为 `true`，红在该断言；恢复 HEAD 后原 spec 15/15 绿。现有测试名叫
   “with nothing to press”，却没有断言按钮不存在；“does not submit before there are six”也只输入五位，
   没按实际存在的按钮（`apps/web/features/identity/email-code.spec.tsx:65`–`:102`）。冻结 PRD 已经裁决
   “六位自动提交，不用再确认”（`docs/roadmap/01-login-and-space/prd.md:23`–`:31`）。

   **删除 / 合并：**保留自动提交；删除登录页 Continue 与两个答码 form 的 submit handler，把共用的
   “只在长度完整时提交”收成一个 code-input 行为。增加“五位 + click/Enter 不发请求、页面没有第二个
   确认控件”的行为测试。

   **不删会坏什么：**同一个用户动作继续有两条入口；不完整输入能绕过唯一的前端守卫，测试名称继续
   声称一个页面上明显不成立的事实。

4. **高：设计文档保留 5 个已经不存在的公开 endpoint，并漏掉 7 个当前 endpoint** —
   `docs/roadmap/01-login-and-space/design.md:189`、
   `docs/roadmap/03-talking-to-an-agent/design.md:438` — 协议 / 文档漂移 / 名词

   触发：客户端按 01 design 调 `POST /auth/email-codes/{id}/answer`，或按 03 design 调
   `GET /conversations/{id}`。实际入口分别是 `POST /browser/sessions`
   （`apps/server/src/server/sign-in-api.ts:87`–`:107`）和带 Space 身份的
   `GET /spaces/{slug}/conversations/{id}`（`apps/server/src/server/conversation-api.ts:288`–`:314`）。

   结果：照稳定 design 实现的客户端直接得到 404；conversation 客户端还会漏掉 Space membership
   边界。静态集合比对结果为：design 有 36 个唯一 method+path，其中仅 31 个存在于生成契约；实际契约
   有 38 个。

   **删除 / 合并：**删除五个旧拼法：两个 `...email-codes/{id}/answer` 和三个无 `/spaces/{slug}` 的
   conversation 路径。换成当前五个路径，并补上当前 design 未记的
   `POST .../{id}/stop` 与 `PUT /machines/current/conversations/{id}/session`
   （`apps/server/src/server/conversation-api.ts:404`–`:419`、`:472`–`:484`）。design 的 endpoint 集合应
   从 31/38 对齐到 38/38；运行时 endpoint 不增加。

   **不收口会坏什么：**“契约从路由导出”的同一段 design 同时给出另一份假契约；下一位实现者无论信
   文档还是信 OpenAPI，都必须先猜哪一个才是当前答案。

5. **高：03 design 同时教三种互斥的 turn/crash 模型，其中两种已被代码删除** —
   `docs/roadmap/03-talking-to-an-agent/design.md:135`、`:187`、`:275`、`:343`、
   `apps/server/src/conversation/transcript.ts:1` — 架构 / 文档漂移 / 死路径

   触发 A：维护者照 schema 段和决定⑥的“没有 turns 表、从最后一条 message 派生”实现新领取逻辑
   （`docs/roadmap/03-talking-to-an-agent/design.md:275`–`:303`）。实际 migration 已解释这种推导会让
   两个进程重复运行同一问题，也会在 agent 未落第一行前死掉时自动重放外部动作，并已用 `turns` ledger
   取代它（`apps/server/migrations/20260829090000_a_turn_is_taken_once.sql:1`–`:44`）。源码头注释仍说
   turn boundary 不在第二张表（`apps/server/src/conversation/transcript.ts:4`–`:8`）。

   触发 B：daemon 重启。决定④说“不读 agent 记录，直接收 unknown”
   （`docs/roadmap/03-talking-to-an-agent/design.md:187`–`:215`），决定⑧和三态段却说先读文件、补 transcript，
   查证失败才 unknown（`:352`–`:364`、`:425`–`:432`）。当前代码和行为测试走前者：
   `forgetStranded` 直接落 `unknown`（`apps/server/src/db/conversation.spec.ts:492`–`:509`）。

   结果：按 A 会恢复已经删除的 transcript 执行账并允许重复运行；按 B 会把没有可靠 turn boundary 的
   agent 文件猜成完整 transcript，页面显示实际上编出来的记录。

   **删除 / 合并：**删除“不建 turns”“开合是两条消息”“因为没有轮次表”及 transcript 源码假注释；
   让 turn ledger/migration 成为唯一当前答案。删除决定⑧中读文件/补行和三态中的“查证失败”分支，合并
   到决定④的直接 unknown；历史研究过程移回 Issue。

   **不删会坏什么：**同一份稳定 design 对最危险的重复执行与 crash 恢复各给两套相反指令，任何一套
   都能被引用为“按设计实现”。

6. **中：机器 owner 在 enrolment 与 machine 各存一份，权限读取只信没有一致性约束的副本** —
   `apps/server/migrations/20260903090000_a_machine_belongs_to_whoever_connected_it.sql:17`、
   `apps/server/src/db/machine.ts:34`、`apps/server/src/db/machine.ts:269` — 派生存储 / 权限

   触发：数据修复或后续 migration 更正 `enrolments.approved_by` 为 B，却没有同时更正
   `machines.owner_user_id`。`machines.enrolled_from` 已经保留了两行之间的关系；当前 schema 没有约束
   两个 owner 相等。最初 migration 正是从 `approved_by` 复制出第二列（`:19`–`:26`），领取时又在
   TypeScript 复制一次（`apps/server/src/db/machine.ts:44`–`:63`）。

   结果：批准账说 B，Space 可达性、owner 显示和 Disconnect 权限仍全部信 A 的副本
   （`apps/server/src/db/machine.ts:269`–`:277`、`:295`–`:310`、`:353`–`:364`）。A 仍能看到/断开机器，
   B 看不到自己批准的机器；数据库不会拒绝这组矛盾。

   **删除 / 合并：**删除 `machines.owner_user_id` 与 `machines_of_owner`；经
   `machines.enrolled_from → enrolments.approved_by` 读取唯一 owner，并为这条 join 建需要的索引。若实测
   必须缓存，则至少像 `turns.machine_id` 一样写出性能证据和数据库一致性约束；目前两者都没有。

   **不删会坏什么：**每次 owner 数据修复、导入或迁移都成为双写；漏一边时，展示与授权同时读错人。

7. **中：三个 pnpm store SQLite 文件被提交为源码；运行测试本身会改写仓库** —
   `.gitignore:1`、`docs/repository.md:5`、`docs/repository.md:171` — 仓库 / 死生成物

   触发：在 HEAD 上直接运行本地 Vitest。运行后 `git status` 显示
   `.pnpm-store/v11/index.db` 被修改、`index.db-shm` 和 `index.db-wal` 被删除；三者均为 Git 已跟踪的
   SQLite/cache 文件，随后已从冻结的 HEAD 快照逐字节恢复。

   结果：一个只读验证动作制造二进制 diff；下一次提交可以无意带入本机 WAL，评审无法读内容，也没有
   稳定生成规则。根目录清单没有 `.pnpm-store`（`docs/repository.md:7`–`:38`），而 `.gitignore` 也没有
   忽略它（`.gitignore:1`–`:15`）。

   **删除 / 合并：**从 Git 删除 `.pnpm-store/v11/index.db`、`index.db-shm`、`index.db-wal`，在
   `.gitignore` 加 `.pnpm-store/`。它不是仓库生成物，也不应搬进 `generated/`。

   **不删会坏什么：**每次 pnpm/test 都可能让干净 checkout 变脏或产生不可评审的二进制提交；“只改
   report”与“跑验证”也无法同时成立。

## 用户可见动作与全部入口

这里的“入口”按真正执行行为的 UI/CLI/HTTP writer 计；普通链接若全部汇入同一 route/query，只列其
上下文，不把每个 `<a>` 当成另一套实现。生产代码中从 `server/src/db` 之外直接写数据库的用户入口为
**0**。

| 用户可见动作                                     | 所有入口                                                                                                 | 结论                                            |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 用 provider 登录                                 | `/sign-in` provider button → `POST /auth/{provider}/start` → callback                                    | 1                                               |
| 请求 / 重发登录码                                | `/sign-in` Continue；`/sign-in/code` Resend → 同一 `POST /auth/email-codes`                              | 1 writer；后者是失败恢复                        |
| 回答登录码                                       | `/sign-in/code` 第六位 auto；Continue/form submit → `POST /browser/sessions`                             | **2，发现 3**                                   |
| 改显示名                                         | `/settings` → `PATCH /me`                                                                                | 1                                               |
| 连接 provider 凭据                               | `/settings` → `POST /me/credentials/{provider}/start`                                                    | 1                                               |
| 添加邮箱凭据                                     | `/settings` 发码；答码的第 N 位 auto 与 Enter/form submit → `POST /me/credentials`                       | **答码 2，发现 3**                              |
| 退出                                             | Space 的 Account link 或 Spaces 列表先到同一个 `/settings` Sign out → `DELETE /browser/sessions/current` | 1 writer                                        |
| 新建 Space                                       | `/onboarding` 唯一表单 → `POST /spaces`                                                                  | 1                                               |
| 进入已有 Space                                   | onboarding card、conversation/Inbox/parent-child links、直接 URL → 唯一 `/s/{slug}` 读取                 | 1 route contract；frame 实现为 2，发现 2        |
| 接一台有终端的机器                               | CLI `handover connect`；`/connect` 与 `/connect/{code}` 只是同一 `Connect` 页的手输/完整链接             | 1 enrolment writer；两种到达方式由 PRD 明确保留 |
| 批准 / 拒绝机器                                  | 同一 Connect 页各一个动作 → `POST /me/machines` / `POST /enrolments/{code}/refuse`                       | 各 1                                            |
| 用 key 接无浏览器机器                            | `/onboarding/host` key fallback；Space Machines panel → `POST /me/machine-keys`                          | **2 surfaces，发现 1**                          |
| 前台诊断已连接机器                               | CLI `handover run`                                                                                       | 1；不负责 enrolment                             |
| 断开机器                                         | Space Machines 自己的行 → `DELETE /me/machines/{id}`                                                     | 1                                               |
| 新开 conversation                                | Space Machines 中一个在线 agent button → `POST /spaces/{slug}/conversations`                             | 1                                               |
| 打开既有 conversation                            | sidebar、Inbox、父/子任务链接、直接 URL → `/s/{slug}/c/{id}`                                             | 1 canonical read；多个是对象引用                |
| 说一句 / 停一轮                                  | conversation composer 的 Send / Stop → 各自唯一 endpoint                                                 | 各 1                                            |
| 交办 / 收回                                      | proposal 上 Hand it over；Underway 上 Take it back                                                       | 各 1                                            |
| agent 提议 / 交给另一个 agent                    | CLI `handover task new`；带 `--to` 时是子任务                                                            | 一个动词，两种明确接收者，不是平行实现          |
| agent 等人 / 睡到时刻 / 完成 / 不能完成 / 写产出 | CLI `task wait` / `sleep` / `done` / `cannot` / `output`                                                 | 每个动作各 1                                    |
| 查看产出                                         | conversation 的 Underway rail 中展开 output                                                              | 1                                               |

## 数了什么（3.4）

左侧是本轮 HEAD，右侧是以上删除完成后的目标；不是用“无基线”冒充 0。

- **用户要学的名词：**9 个领域概念不变；代码/route 对同一机器另叫 `host`：2 个名字 → 1 个。人能看见的
  `Space/workspace` 两词仍是 1 个未裁决分裂，放在 UNVERIFIED。
- **状态：**9 → 9（task 4、conversation 投影 3、machine presence 2）；本轮没有理由增加状态。
- **问人的问题：**首次交办所需的 8 个领域问题保持 8；验证码额外确认控件 1 → 0。
- **存下来的事实：**14 表 / 91 列 → 14 表 / 87 列：删除 `machines.owner_user_id`、
  `agents.found_at`、`messages.id`、`outputs.id`。`turns.machine_id` 是仍保留的 1 个有意派生副本：migration
  给出 hot partial-index 证据，并有 composite FK 防漂移
  （`apps/server/migrations/20260904090000_a_turn_cannot_name_a_machine_the_conversation_is_not_on.sql:1`–`:21`）。
- **做同一件事的路：**四个命中动作合计 8 → 4（machine-key surface、Space frame、登录答码、绑邮箱答码
  各 2 → 1）。
- **命令 / 接口：**运行时 38 HTTP method+path / 35 path、9 个 CLI form，均不增加；design 与实际契约
  的交集 31/38 → 38/38；web file routes 10 → 9（删除 Host route）。
- **死表面：**无消费者的导出/别名 4 → 0；Git 跟踪的 pnpm cache 3 → 0。
- **CSS：**两个 CSS 文件共 141 个唯一 class 名；逐字引用为 0 的 4 个都是
  `mark-${state}` 的动态取值（`apps/web/mark.tsx:18`–`:36`），所以当前孤儿 class 为 **0**。发现 1 完成后，
  只服务 Host/两步 rail 的 `host-*`、`shell-*`、`steps-*` 35 个 class 可一起删除：141 → 106。
- **定长清单：**4 个 roadmap journey / 上限 8；没有新增第 5 条。

其中 `agents.found_at` 每次和 machine check-in 一起改写，却没有任何读者
（`apps/server/migrations/20260825090000_machines_and_agents.sql:72`–`:81`、
`apps/server/src/db/machine.ts:183`–`:207`）；`messages.id` 与 `outputs.id` 也没有领域消费者，而各自行已由
`(conversation_id, seq/key)` 与 `(task_id, title)` 定义身份
（`apps/server/migrations/20260826090000_conversations.sql:37`–`:64`、
`apps/server/migrations/20260902090000_a_piece_of_work_you_walked_away_from.sql:55`–`:67`）。保留它们只会给同一
行第二个名字。

## DELETIONS

- 删除 `apps/web/routes/onboarding_.host.tsx`、`features/onboarding/host.tsx`、`host.spec.tsx`；把唯一完整的
  key expiry/retry/poll 行为合到 `Machines`。
- 删除 `features/onboarding/steps.tsx` 及 `style.css` 中只服务两步 Host 旅程的 `steps-*`、`host-*`、
  `shell-*`；单一 Space 创建动作不需要进度状态机。
- 删除 `.21st/design.json` / 生成 `DESIGN.md` 中“创建 Space 后进入 Host”的产品分支；视觉简报不再复制
  PRD 的旅程决定。
- 删除两个 Space leaf route 里的重复 query、pending/error/404、`Home` scaffold；合并进唯一 parent
  layout。
- 删除登录验证码的 Continue、两个答码 form submit handler；只保留完整长度自动提交。
- 删除 01/03 design 的 5 个旧 endpoint 拼法，合并为生成契约中的 7 个当前条目。
- 删除 03 design 的“没有 turns 表”、transcript 派生执行账、读 agent 文件补 crash transcript 三段，以及
  `transcript.ts` 的同义假注释。
- 删除 `machines.owner_user_id`、`machines_of_owner`；owner 只从 enrolment 读取。
- 删除零消费者持久化列 `agents.found_at`；删除第二身份 `messages.id`、`outputs.id`，分别把现有领域唯一键
  作为主键。
- 删除 `.pnpm-store/v11/index.db`、`index.db-shm`、`index.db-wal`，并忽略整个 `.pnpm-store/`。
- 删除无调用的 `GmailMark`（`apps/web/features/identity/provider-marks.tsx:49`–`:59`）、无引用的 `Role`
  alias（`apps/server/src/conversation/transcript.ts:178`）、`HandwritingSvg` 的未用 default export
  （`apps/web/components/ui/handwriting-svg.tsx:248`）；把仅本文件调用的 `openTurnsOn` 改为非 export
  （`apps/server/src/db/turn.ts:267`–`:283`）。不删会让重命名/模块收口后旧入口仍在类型提示里存活。

## UNVERIFIED

- `.21st/DESIGN.md:1` 自称由 `.21st/design.json` 生成，且全仓库没有文件引用它；它很像同一设计事实的
  第二份提交副本。缺的证据是 21st 外部工具究竟消费哪个文件；确认只读 JSON 后应删除生成 Markdown。
- `apps/server/src/server/waker.spec.ts:68`–`:72` 名称声称“deployment 没事可做”，身体没有建立/隔离任何
  fixture，断言 `rows.length >= 0` 也保护不了 `sleep_until <= now()`。缺的证据是一次正确原因的 mutation
  red；当前环境连接 `127.0.0.1:5442` 被 sandbox 以 EPERM 拒绝，测试只红在数据库不可达，不能升级为
  finding。
- `Space` 与 `workspace` 指同一对象：代码/API/绝大多数 UI 用前者，创建表单用后者；但 PRD 本身明确写
  `Workspace name`（`docs/roadmap/01-login-and-space/prd.md:41`–`:48`）。缺的是人的命名裁决；改任一边都会
  改用户可见名词，不能由本轮擅自决定。
- `outputs.created_at` 没有生产读者，只有 `updated_at` 出现在 UI；它可能是死事实，也可能是尚未写明的
  审计保留。缺的是 owner 对“首次创建时间是否是产品/审计合同”的明确回答。

## 退出评审

- 本轮只写报告，没有修改生产代码或测试；新增机械化规则为 **0**。
- 临时验证码行为断言按预期红（五位 + Continue 仍发请求）；撤掉临时断言后
  `email-code.spec.tsx` **15/15 通过**。
- 临时 Space HTTP-503 行为断言按预期红（实际显示 “not available”）；临时改动已撤掉。HEAD 中现有
  `HttpResponse.error()` 测试不覆盖该输入。
- `pnpm check` 未执行成功：package-manager 入口拒绝 `pnpm@10.20.0` 的 registry signature；直接 DB
  spec 又因 sandbox 拒绝 Postgres 连接而失败。没有把环境失败当成代码 finding。
- 没有运行需要真实 server/agent 的端到端旅程或 `test:agents`，因此本轮不声称真实旅程通过。
