# Handover 全项目评审 · Round 1

评审对象：`HEAD 1e2c649066e83aad4ec701a86c2fdda273a77860`。评审期间出现的工作区并发改动不属于
HEAD，也未纳入结论。

范围是架构与正确性，重点读完了 `apps/server/src/db/*.ts`、
`apps/server/src/server/*.ts`、16 个 migration、生成 schema、真实 CLI 调用方、相关测试，以及
`AGENTS.md`、四份稳定文档和四片 roadmap 的 PRD/design。以下发现按严重度排序。

## 发现

1. **严重：数据库没有裁决“一台机器一次只能有一个 open turn”这个赢家** —
   `apps/server/src/db/turn.ts:161`、`apps/server/src/db/turn.ts:165`、
   `apps/server/src/db/turn.ts:177`、`apps/server/generated/schema.sql:541` — 架构 / 逻辑

   触发：同一台机器上有两段待处理对话，两条候选消息的 `created_at` 相同；两个 server 实例同时
   执行 `takeOne`。两个 statement snapshot 都在 `not exists` 中看到机器不忙；按创建时间排序对
   并列项没有第二排序键，两个实例分别选中不同 conversation，并分别插入 turn。

   结果：`turns` 的主键只竞争 `(conversation_id, after_seq)`，两个 insert 都成功；同一目录里同时
   跑两个 agent，文件互相覆盖，直接违反 PRD ⑫。

   证据：`turns_open_on_machine` 是普通 partial index，不是 unique index；现有测试也明确承认两个
   实例能留下两个 open turn，却在夹具里直接插入两行，只测试重启后的清理，没有测试竞争本身
   （`apps/server/src/db/conversation.spec.ts:529`）。

   处置：机械化（先写两个独立连接并发 `takeOne`、最终恰好一个成功的失败测试，再让数据库产生
   唯一赢家）。

2. **严重：`restarted` 既不是幂等事件，也没有把 `unknown` 的交办任务转成 `wait`** —
   `apps/server/src/server/machine-api.ts:318`、`apps/server/src/db/turn.ts:352`、
   `apps/server/src/db/turn.ts:368`、`apps/cli/src/checking-in.ts:151` — 架构 / 逻辑 / 产品

   触发 A：一个 handed-over turn 已经执行过外部写入，daemon 被 `kill -9`；新进程第一次上报
   `restarted: true`。`forgetStranded` 写 `unknown` 并结束 turn，但没有执行
   `waitsForAPerson`；同一次请求随后进入 `anythingFor`。

   结果 A：task 仍是 `working`，`carryingOn` 立即把 `unknown` 后面开成下一轮，agent 自动重复那次
   外部写入；`unknown` 被自动重放，违反 `docs/architecture.md:87` 和
   `docs/roadmap/04-handing-something-over/prd.md:294`。

   触发 B：server 已处理第一次 `restarted: true`、并从 `takeOne` 认领了一个新 turn，但 HTTP
   响应在客户端收到前丢失。CLI 直到收到成功响应才把 `restarted` 清成 false，故第二次仍上报 true
   （`apps/cli/src/checking-in.ts:154`、`apps/cli/src/checking-in.ts:167`）。

   结果 B：第二次 `forgetStranded` 把刚认领、客户端从未看到的 turn 记成 `unknown`。普通对话的一句
   问话因此永远没有到达 agent；交办任务则再次触发结果 A。

   证据：正常 machine ending 会在同一事务调用 `waitsForAPerson`
   （`apps/server/src/db/conversation.ts:226`），restart 清理没有这一步；poll 又在清理后无条件取下一轮
   （`apps/server/src/server/machine-api.ts:320`）。

   处置：升级给人（公开 poll 协议需要一个可去重的进程启动身份；同时确定 `unknown → wait` 的唯一
   ledger writer）。

3. **严重：收回根任务的递归 snapshot 会漏掉并发新建的后代** —
   `apps/server/src/db/task.ts:200`、`apps/server/src/db/task.ts:211`、
   `apps/server/src/db/conversation.ts:498`、`apps/server/src/db/conversation.ts:514` — 逻辑 / 产品

   触发：根任务 R 已有子任务 C。C 的机器开始 `handOffTo`，锁住 C 的 conversation/task 并插入孙任务
   G，但尚未提交；同时人对 R 调用 `takeBack`。递归 CTE 的 statement snapshot 在 G 提交前建立，遍历
   到 C 后，update 等待 C 的锁。C 的事务随后提交 G，take-back 继续并更新 snapshot 中的 R 和 C。

   结果：G 不在已经建立的递归 snapshot 内，保持 `working`；人收到 204、页面说整棵树已收回后，G
   的 agent 仍在另一台机器修改仓库，正是 PRD ⑪禁止的“没人看着、也没人要”的工作。

   证据：take-back 只先锁根 conversation/task，递归 statement 没有一把能与任意后代的
   `handOffTo` 竞争的树级赢家；`handOffTo` 只锁自己的 conversation。

   处置：机械化（用两个连接和 barrier 固定上述提交顺序，断言收回返回后没有 open descendant）。

4. **高：消息幂等键只去重 transcript，重复请求仍会再次改 ledger；判断也仍在读开放 transcript** —
   `apps/server/src/db/conversation.ts:221`、`apps/server/src/db/conversation.ts:226`、
   `apps/server/src/db/task.ts:327`、`apps/server/src/db/turn.ts:243` — 架构 / 逻辑

   触发 A：turn A 的 ending 已成功写入并结束 A，但响应丢失；机器随后拿到 turn B，再用 A 的同一个
   key 重试 ending。`append` 返回 `said-already`，`machineSays` 不检查它，仍用请求里的开放
   `activityType` 调 `openTurn`。

   结果 A：当前 turn B 被 A 的旧 ending 结束；旧 ending 若是 `failed`/`unknown`，当前 handed-over
   task 还会被改成 `wait`。B 可以在仍运行时被当成结束，机器又可领取后续工作。

   触发 B：agent 以 key K 报告 `wait`，响应丢失；人回答后 `backToWork` 已把 task 改回 `working`；
   agent 重试同一个 K。`stopsWorking` 先 `moveTo(wait)`，随后才发现活动消息已经存在。

   结果 B：人的回答被旧重试覆盖，task 从 `working` 回到 Inbox，agent 收不到回答；`sleep` 的旧重试
   同样能把已被人叫醒的任务重新睡下。

   证据：`append` 明确以 `said-already` 表示重复（`apps/server/src/db/message.ts:113`），两个调用方都
   在状态写之后或无条件继续。除此之外，是否 owed、是否 stop、是否 ending 仍分别读取“最后一条用户
   消息”或 `activityType`（`apps/server/src/db/turn.ts:54`、`apps/server/src/db/turn.ts:321`、
   `apps/server/src/db/conversation.ts:242`），与 `docs/review.md:86` 的账/记录边界冲突。

   处置：升级给人（从公开的通用 message 协议移走 turn/task 判定，给封闭 ledger transition 确定唯一
   协议和 writer；所有副作用由幂等赢家返回值守卫）。

5. **高：三个 migration 的 `down` 在迁移后产生过正常数据时不能恢复旧系统** —
   `apps/server/migrations/20260825100000_enrolment_space_at_approval.sql:18`、
   `apps/server/migrations/20260825110000_machine_names_itself.sql:11`、
   `apps/server/migrations/20260903090000_a_machine_belongs_to_whoever_connected_it.sql:39` — 逻辑 / 运维

   触发 A：升级后存在一个尚未批准的 code enrolment；它的 `space_id` 和 `machine_name` 按新 schema
   合法为 null。回滚前两个 migration 时直接执行 `set not null`。

   结果 A：Postgres 因现存 null 行拒绝 DDL，部署卡在一半新、一半旧的 schema。

   触发 B：升级到“机器属于人”后再回滚 20260903。down 只重新添加两个 nullable `space_id`，没有从
   owner 的 memberships 选择或恢复任何值，随后就删除 `owner_user_id`。

   结果 B：旧代码按 `machines.space_id` 查询时看不到任何既有机器；人在所有 Space 中同时失去机器，
   也无法继续原对话。

   证据：三个 down 都没有拒绝回滚、数据清理或 backfill；20260903 的 up 则已不可逆地 drop 原始
   `space_id`（同文件 `:28`–`:37`）。

   处置：机械化（在有 pending enrolment、既有 machine 的升级后 schema 上逐个执行 down，并跑旧版
   关键查询；不能忠实回滚的 migration 必须明确阻断而不是产出可启动的错误 schema）。

6. **高：机器路由的门没有在写事务里保护实际资源，且 live 路由完全不核对 conversation owner** —
   `apps/server/src/db/task.ts:260`、`apps/server/src/server/live-api.ts:120`、
   `apps/server/src/server/machine-session.ts:31` — 架构 / 权限

   触发 A：机器请求先通过 `requireMachine`；owner 随后提交 DELETE 移除该机器；原请求再进入
   `stopsWorking`、`writesOutput` 或 `handOffTo`。`onItsOwn` 只锁 conversation 并比对
   `machine_id`，没有 join/lock `machines`，也没有检查 `removed_at`。

   结果 A：已经被移除的凭据仍能把 task 改成 wait/done、覆盖 output，或在别的机器上新开 child；
   “移除后下一次调用立即失效”出现一次完整的越权写。

   触发 B：任意仍有效的机器凭据向
   `POST /machines/current/conversations/{另一台机器的 conversationId}/live` 发送合法 moment。

   结果 B：正在观看那段 conversation 的人看到来自错误机器的 thinking/tool activity，并把它当成
   自己 agent 的实时行为；handler 注释所说的“只影响错误屏幕”就是完整的跨 conversation 完整性失败。

   证据：普通 transcript 写入已正确在事务中 join、锁并检查 machine
   （`apps/server/src/db/conversation.ts:209`）；task helper 的注释声称做了同一检查，函数体却没有。

   处置：机械化（用 remove 提交夹在 middleware 与写事务之间的 barrier 测试；live 测试断言错误
   machine/conversation 组合不向 watcher 发事件）。

7. **高：邮件已经发送、delivery 记账失败时，同一个请求会在 30 秒后发送第二封并废掉第一封验证码** —
   `apps/server/src/server/email-code.ts:214`、`apps/server/src/db/email-code.ts:237`、
   `apps/server/src/db/email-code.ts:189` — 逻辑 / 外部后果

   触发：邮件 provider 返回 `sent`，随后 `noteDelivery` 的数据库 update 短暂失败。`sending` 传播异常，
   HTTP 返回 500；30 秒后浏览器以同一个 request key 重试。

   结果：原 row 的 `delivery` 仍是 null，被 `replay` 判为 abandoned 并删除；新 row、新 code 和第二封
   邮件被创建，第一封中人正在输入的 code 同时失效。一次用户请求造成两封成功邮件。

   证据：`noteDelivery` 的注释承诺记账失败“不应让请求失败”
   （`apps/server/src/db/email-code.ts:247`），调用方却 `await` 且没有失败分支；删除 abandoned row 的
   路径随后可见。

   处置：升级给人（外部邮件发送需要能消费 request identity 的幂等边界，或明确选择其他可证明不会
   重复外部后果的协议）。

8. **中：per-caller 邮件额度只做 count，没有让同一 caller 的并发请求竞争** —
   `apps/server/src/db/email-code.ts:42`、`apps/server/src/db/email-code.ts:178`、
   `apps/server/src/db/email-code.ts:199` — 逻辑 / 成本

   触发：额度还剩 1，来自同一个 `askedBy` 的两个请求同时给两个不同 email 发码。现有 advisory lock
   只按 `purpose:email`，所以两个事务拿不同锁；两个 count statement 都在对方 insert 前读到额度未满。

   结果：两行都插入、两封都发送，额度 1 实际消费 2；并发扩大后，攻击者能超过配置上限花费邮件
   成本并损伤发送域信誉。

   证据：现有额度测试只串行发送三次再检查第四次
   （`apps/server/src/db/email-code.spec.ts:277`），没有不同地址的并发断言。

   处置：机械化（两个地址、同一 caller、额度 1 的并发测试必须恰好一个 `issued`；锁/赢家由数据库
   实现）。

## 七项全项目读数

1. **并存旧路径：0 条已确认。** 枚举了 37 个 HTTP endpoint、9 个 CLI command form；code/key
   enrolment、Stop/发新消息、`task new` 的两种用法各有不同的触发者或产品语义，不是遗留平行入口。
   生产代码中直接 SQL 写入 server `db/` 之外为 0。
2. **派生与存储：14 张表、91 列；1 个明确有意存下的派生值。** `turns.machine_id` 可从
   conversation 推导，但 migration 写明为 hot partial index 保留，并用 composite FK 阻止两份不一致
   （`apps/server/migrations/20260904090000_a_turn_cannot_name_a_machine_the_conversation_is_not_on.sql:17`）；
   没有由此得到具体错误结果，故不报 finding。其余未发现能产生具体漂移错误的派生列。
3. **死东西：0 个已确认。** 检查了 db 边界 71 个 value export 的生产引用，未找到仅定义无调用者的
   导出；没有找到无人引用的稳定文档段落或已被替代仍可运行的用户入口。
4. **名词分裂：0 个达到正确性 finding。** `task`（代码/CLI）与“一件事”（中文 PRD/UI）是同一概念
   的层级翻译；当前没有输入因此走错接口或得到错误结果，故不报风格项。
5. **文档/代码漂移：5 组。** 对应发现 1（唯一赢家）、2（unknown）、4（账/记录）、5（可回滚性）和
   6（移除后的门）；其中多处函数注释正好声称了函数体没有做到的保证。
6. **机械化覆盖：6 条全局规则。** `server/app.spec.ts` 机械化 4 条 route gate/contract 规则，
   `db/sql.spec.ts` 机械化 2 条手写 SQL 边界规则；本报告 8 条行为失败目前都没有覆盖其触发顺序的测试。
   仓库没有上一次里程碑报告，趋势数字不可比较。
7. **清单：4 条 roadmap journey，未超过 8。** 四份 PRD 都有具体失败/验收旅程；本报告当前 findings
   同样固定为 8 条。

## 数了什么（3.4）

没有上一次里程碑报告，所以下列左侧是“无基线”，不是 0：

- 用户要学的名词：无基线 → **9**（人/账户、Space、机器、agent、对话、一轮、一件事、Inbox、产出）
- 状态：无基线 → **9**（task 4、conversation 投影 3、machine presence 2）
- 问人的问题：无基线 → **8**（首次交办 happy path 中的登录方式、地址、验证码、Space 名、批准机器、
  选择机器、选择 agent、确认交办；model/effort 是可选项，未计）
- 存下来的事实：无基线 → **91 列 / 14 表**；其中 1 个派生副本有显式性能理由和数据库一致性约束
- 做同一件事的路：无基线 → **0 条已确认的重复路**
- 命令 / 接口：无基线 → **46**（37 HTTP + 9 CLI）

## 删除

- 删除 transcript 作为执行账的路径：`beingAsked` / `stillOwed` 对最后一条用户消息的判定、
  `stopWantedOn` 对 activity 的判定、`ends` / `wentWrong` 对开放 `activityType` 的判定。它们被封闭的
  question/turn/task ledger transition 接管后不再需要存在；继续保留就会维持发现 4 的第二 owner。

除此之外删除清单为空：71 个 db value export、37 个 route、9 个 CLI command form 中没有确认的死
入口；其余 findings 指向仍在承载产品行为的路径，不能只删半边。

## UNVERIFIED

- `takeBack` 只证明 caller 是 Space member，没有证明是 task 的 `owner_user_id`
  （`apps/server/src/db/task.ts:200`）。缺的证据是当前产品是否支持第二个 member，以及冻结的权限承诺
  是否允许任意 member 收回别人负责的工作；在这两点明确前不列权限 finding。
- 真实 adapter 旅程 10/10 失败：Claude 明确返回 `not logged in · please run /login`，Codex 也没有产生
  session/answer。缺的证据是两套 CLI 已登录后的真实运行结果；这些失败不能证明 adapter 代码错误。
- DB/server specs 与本报告中的并发复现没有实际执行。缺的证据是一套可访问的 Postgres：当前环境访问
  `/Users/zane/.colima/default/docker.sock` 被拒绝。代码路径已经足以形成 findings，但没有把它们写成并
  红过行为测试。

## 退出评审

- 本轮只写报告，没有新增或修改测试，所以新机械化规则为 **0**。
- 直接运行四个 TypeScript project 的 typecheck：通过；四个 type-aware lint：通过；Prettier
  `--check .`：通过。
- unit + web：**46 files / 446 tests 通过**。web 测试有现存 MSW unhandled-request stderr，但退出码为
  0。
- `pnpm check` 没有完整跑通：generate/db project 需要当前不可访问的 Docker/Postgres。
- `test:agents`：**1 file / 10 tests 失败**，归入上面的登录态 UNVERIFIED；没有把它误报成代码 finding。
- 没有运行可依赖 server/agent 的真实浏览器交办旅程，因此 Round 1 不能给出“真实旅程已通过”的证据。
