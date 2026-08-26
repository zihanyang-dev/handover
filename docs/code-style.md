# Handover 代码美学

代码要像一份关于责任的准确记述:谁校验、谁决定、谁持久化、谁执行外部动作、答案未知时会发生什么。

**只收两类规则:通用工具能机械检查的,和明确标注「人工」的。产品语义由行为测试保护,不写扫描源码词汇或目录名单的业务检查。**

生成代码和 vendored 代码全部排除。

## 0. 语言与强制方式

**文档用中文,代码用英文。** 注释、标识符、错误信息、测试名、提交信息一律英文。

`tsc` 编译器 · `lint` oxlint · `fmt` prettier · `gen` 生成物,手写即违规 · `test` 产品承诺的行为证据 · `人工` 完整 diff 的责任评审

---

## 1. 阻断项

任何一条成立,diff 不合并。

| #   | 阻断                                                                                          | 强制                |
| --- | --------------------------------------------------------------------------------------------- | ------------------- |
| B1  | 对同一行动者,不同恢复方式合并成一个错误;或同一恢复方式拆成多个同错分支;或刻意统一却没说明约束 | `test` + `人工`     |
| B2  | 长条件藏在 `isValid` / `check` / `verify*` 里                                                 | `人工`              |
| B3  | command 或对象字面量携带接收方拥有或可推导的事实                                              | `人工`              |
| B4  | 闭合联合的 `switch` 没有以 `assertNever` 收尾                                                 | `lint` + `人工`     |
| B5  | 一个函数同时做线格式解析、产品策略、数据库事务和网络 I/O                                      | `人工`              |
| B6  | 事务是一堵匿名的墙,而不是有名字的线性阶段                                                     | `人工`              |
| B7  | 同一个值在没有新边界事实的情况下被再校验;或把事务前预检查当作最终授权                         | `人工`              |
| B8  | helper / type / 模块只做转发、改名或减少行数                                                  | `人工`              |
| B9  | 测试断言的是仪式、调用顺序或同一事实的另一种表示                                              | `人工`              |
| B10 | 模块不对应事实 owner、进程 adapter 或明确命名的边界;文件名不说明内聚行为                      | `人工`              |
| B11 | 节点关闭时,被它替代的路径还活着                                                               | `人工`              |
| B12 | 手写了本该生成的东西(wire 类型、校验器、数据库类型)                                           | `gen` + `人工`      |
| B13 | 浮空的 Promise                                                                                | `lint`              |
| B14 | `any`,除非有窄豁免并写明为什么无法收窄                                                        | `lint`              |
| B15 | 控制流嵌套超过两层                                                                            | `lint`(`max-depth`) |
| B16 | 文件名不是 kebab-case,或类型名带 `I` 前缀                                                     | `人工`              |

拆分依据是**责任和事务阶段**,不是行数。

---

## 2. 代码形状

代码是**顺序的段落**,不是嵌套的漏斗。读者从上往下读,不需要在括号之间跳。

### 2.1 嵌套最多两层 `lint`

```json
{ "max-depth": ["error", 2] }
```

第三层意味着漏了一次提前返回或一次抽取。**没有豁免**——真的需要就抽一个具名函数出来,那个名字本身就是文档。

### 2.2 卫语句先行,happy path 贴左边 `人工`

```ts
// 错:主逻辑被推到最右边
async function accept(request: Request) {
  if (request.member) {
    if (request.member.active) {
      if (request.agent.online) {
        return commit(request)
      } else {
        return err('agent-offline')
      }
    } else {
      return err('member-inactive')
    }
  } else {
    return err('no-member')
  }
}

// 对:失败先走完,主逻辑一路平铺
async function accept(request: Request) {
  if (!request.member) return err('no-member')
  if (!request.member.active) return err('member-inactive')
  if (!request.agent.online) return err('agent-offline')

  return commit(request)
}
```

**`return` 之后不写 `else`。**

### 2.3 一个函数一个抽象层 `人工`

一个函数里不同时出现"解析 JSON"和"决定要不要收费"。混层是 B5,不是风格问题。

### 2.4 段落之间空行,每段做一件事 `人工`

```ts
async function reconcile(report: AgentReport) {
  const machine = await lockMachine(report.machineID)
  if (machine.revoked) return err('machine-revoked')

  const known = await loadPresence(machine.id)
  const changes = diffPresence(known, report.observations)

  await applyPresence(machine.id, changes)
  return ok(changes)
}
```

**加载 → 判定 → 应用**,三段,每段之间一个空行。事务阶段在视觉上就是可见的(B6)。

### 2.5 其余形状规则 `lint`

```json
{
  "complexity": ["error", 10],
  "max-params": ["error", 4],
  "max-nested-callbacks": ["error", 3],
  "max-lines-per-function": ["error", 60],
  "max-statements": ["error", 25]
}
```

这几条平时不会响。它们是保险,不是目标——**响了说明形状已经坏了,不是把数字调大。**

参数超过 4 个改成一个具名的 options 对象;但那个对象必须是**一个真实的概念**,不是参数袋(B3)。

---

## 3. 命名

### 3.1 文件 `人工`

```text
kebab-case.ts              agent-registration.ts · work-request.ts · http-exception.ts
一个文件一个内聚行为        文件名说得出它拥有什么
测试同名                    agent-registration.test.ts
```

禁止 `index.ts` 之外的桶文件。`index.ts` 只做再导出,不含逻辑。

### 3.2 类型 `人工`

```ts
// 对
export interface AgentReport { … }
export type WorkOutcome = { kind: 'succeeded' } | { kind: 'failed' } | { kind: 'unknown' }

// 错
export interface IAgentReport { … }      // I 前缀
export type TWorkOutcome = …             // T 前缀
export interface AgentReportInterface {} // 后缀说的是语法不是事实
```

- `interface` 用于会被实现或扩展的形状;其余一律 `type`
- 名字是**这个事实是什么**,不是它在代码里的角色
- 泛型参数用有意义的词:`<Command>` `<Outcome>`,不是 `<T>` `<K>`——除非它真的是任意的

### 3.3 函数 `人工`

```text
动词短语        loadPendingConnection · reconcileAgentPresence · rejectStaleFence
返回布尔的      isActive · hasPendingWork · canEnrollHost
纯计算          不用动词也行:agentInitials(name) · nextOrdinal(family)
```

不叫 `handle*` `process*` `manage*` `do*` `run*`(除非它真的是"运行一个进程")。

**函数名要说出它拥有的那条规则**,不说它在流程里的位置。`consumeInvitation` 好过 `step3`。

### 3.4 变量 `人工`

```text
布尔          is / has / can / should 开头
集合          复数:observations · pendingKeys
单个          单数,不加 Item / Obj / Data
时间          带单位或时态:expiresAt · pollIntervalMs · lastSeenAt
ID            带类型:workID · agentID —— 且跨边界时是 branded
```

不用 `data` `info` `result` `value` `item` `temp` `res` 当名字,除非上下文里它真的没有更准的词。

### 3.5 少用 class `人工`

`class` 只用于**调用方持有的、有身份的有状态对象**(一个 server 实例、一个查询构造器)。

owner 的规则是函数,数据是 `type`,adapter 是实现接口的对象字面量。

```ts
// 错:只是把函数装进一个壳
class WorkValidator { validate(w: Work) { … } }

// 对
export function validateWork(work: Work): Result { … }
```

`typescript/no-extraneous-class` 拦掉只有静态成员的壳。

### 3.6 禁止词 `人工`

标识符和文件名里不出现:

```text
Manager · Processor · Coordinator · Handler · Resource
Payload · Data · Info · Utils · Common · Base · Helper
```

有具体名词就用具体名词。**这条同时拦文件名和导出名。**

---

## 4. 类型是真相

### 4.1 边界解析,内部信任 `人工`

运行时校验只在:**wire · 模型与工具的 JSON 输出 · 配置与命令行 · 持久化读回 · 跨进程消息**。

同进程、已有静态类型的边界不加运行时校验,也不为静态接口已保证的值写恶意输入测试。

### 4.2 边界类型从 schema 推 `gen`

```ts
// 对
const AgentReport = z.object({ … })
type AgentReport = z.infer<typeof AgentReport>

// 错:两份真相,迟早漂移
interface AgentReport { … }
const AgentReportSchema = z.object({ … })
```

### 4.3 相邻的两个不透明 ID 必须命名传参 `人工`

```ts
❌  removeMachine(db, machineId, spaceId)
✅  removeMachine(db, { machine, space })
```

判据是**换了之后编译过、还给出一个像样的错误答案**:两个都是机器生成的、人读不出对错的 id。
`slug` 和 `displayName` 这种人写的名字不算 —— 调换在调用处就看得出来。

**不用 branded string。** 这个系统里的 id 全部来自 wire(zod)或数据库(kysely-codegen),两头
都是生成物;要 brand 就得在每个边界上 cast,而 cast 正是错 id 混进来的地方 —— 编译器拦住的是
写对了的那些人。要让 brand 真的生效,得手写一份生成类型的镜像,那是 B12。

### 4.4 非法状态无法表达 `人工`

```ts
// 错:2⁴ 种组合,多数非法
{ loading: boolean; error: string | null; data: T | null; unknown: boolean }

// 对
| { phase: 'loading' }
| { phase: 'ready'; data: T }
| { phase: 'failed'; recovery: string }
| { phase: 'unknown'; recovery: string }
```

### 4.5 闭合联合以 `assertNever` 收尾 `lint`

```ts
switch (outcome.kind) {
  case 'succeeded': …
  case 'failed':    …
  case 'unknown':   …
  default: assertNever(outcome)
}
```

### 4.6 环境变量只在一处 parse `lint`

`process.env` 只有 `src/env.ts` 能读,别处拿到的是已经 parse 过的 `Env`。

```ts
// 错:每个用到的地方各自猜它存在、猜它的格式
const url = process.env.DATABASE_URL!

// 对:一次 parse,之后是类型
export function parseEnv(source: Readonly<Record<string, string | undefined>>): Env
```

两个细节不能省:

- **空串等于没设。** 否则 `DATABASE_URL=` 报的是"格式不对",而正确的话是"没设" —— 两句话指向完全不同的动作。
- **一次列全。** 配置坏了只有一个行动者、一个恢复(改完重启),按 §5.1 是**一个**错误;但它必须一次说完所有问题,否则每修一条要重启一次。

---

## 5. 错误与恢复

### 5.1 错误的数量由恢复方式的数量决定 `test` + `人工`

```ts
// 错:不同恢复合成一个
if (!code || used || expired || wrongSpace || !permitted) return err('invalid')

// 错:同一恢复拆成四个
if (!isUUID(a)) return err('invalid')
if (!isUUID(b)) return err('invalid')
if (!isUUID(c)) return err('invalid')
if (!validKey(k)) return err('invalid')

// 对:畸形输入只有一种恢复,一个谓词一个错误
if (!isUUID(a) || !isUUID(b) || !isUUID(c) || !validKey(k)) return err('invalid')
```

恢复方式以**收到这份错误并能采取行动的人**为准,不把用户和运维混成一个行动者。

1. 同一行动者,不同失败触发不同恢复 → 独立分支、独立错误
2. 安全或隐私要求隐藏细节 → 统一错误,函数上一行注释写明约束
3. 用户恢复相同但运维处置不同 → 公开错误统一,另留不含私人值的结构化诊断
4. 其余 → 同一判定阶段合并成一个谓词

### 5.2 空 `catch` 要说明它吞了什么 `人工`

```ts
try {
  await store.remove(key)
} catch {
  // 并发清理已经删掉了这个键;调用方的下一步不依赖它存在。
}
```

`try` 块保持一条语句。

### 5.3 owner 错误不拥有 UI 文案 `test` + `人工`

owner 错误有稳定语义和诊断原因,不直接成为公开文案。transport 按行动者和受众分别翻译。

面向人的失败说明只讲:**系统知道什么,用户现在能做什么。**

---

## 6. 模块与文件

模块只为三类责任之一存在:**事实 owner** · **进程 adapter** · **明确命名的边界**。第三类只组合、翻译、适配,不拥有产品策略。

```text
❌  work/service.ts        一个 owner 的全部行为堆在一个桶
❌  agent/manager.ts       名字不说明它拥有哪条行为
❌  common/validation.ts   跨 owner 的垃圾桶
✅  agent/registration.ts  Agent 身份注册这一条行为
✅  db/agent.ts            镜像该 owner 行为的持久化
✅  server/agent-api.ts    这条行为的入站 transport
```

**禁止文件名** `人工`:`service` `manager` `utils` `common` `helpers` `base`

派生视图是查询,不是新文件家族的理由。

---

## 7. 仪式性抽象

```ts
// 错:转发 + 单实现 interface + 桶名字
interface WorkService {
  update(input: UpdateInput): Promise<void>
}
class WorkManager implements WorkService {
  update(input: UpdateInput) {
    return this.repo.update(input)
  }
}
```

判断顺序:词汇和纯规则是否留在 owner → 依赖数据库事实的权威是否仍由事务执行 → interface 是否在实际消费方且最小 → 删掉它是否只会少一次转发。最后一题答"是"就删。

**但派生 owner 拥有的规范化 command、digest 或恢复的方法,不是纯转发。**

新依赖必须移除比它引入更多的自有复杂度,并且当前就有消费者。

### 7.1 `class` 必须拥有实例语义 `lint` + `人工`

事实、command、outcome 和 owner 恢复错误默认是 schema 推导的 readonly 数据、判别联合与模块函数。不能只为命名空间、构造、转发或聚合方法创建 `class`;空、纯静态和只有构造函数的类由 `no-extraneous-class` 拦截。

`class` 必须有以下直接证据之一:

- 外部 API 要求原型身份、`extends` 或真实 `Error`
- adapter 拥有有界的进程内状态,并由同一实例拥有停止、等待与清理
- 不可变 fluent builder 需要跨方法保留泛型推断状态

领域身份不用 `instanceof` 表达;数据库裁决的权威状态不藏进进程内实例;owner 恢复错误不用 `Error` 层级代替闭合联合。class 实例不跨 wire、持久化、模型输出或进程边界,跨越前转换成 schema 推导的普通数据。继承只服务外部合同或真实 subtype 关系,不以复用代码为理由。

### 7.2 合同里的函数成员使用属性语法 `lint`

```ts
interface AgentAdapter {
  execute: (command: AgentCommand) => Promise<RunOutcome>
}
```

不用 `execute(command: AgentCommand): Promise<RunOutcome>`。`strictFunctionTypes` 不严格检查 method syntax 的参数,属性语法才能让过窄的实现编译失败。`method-signature-style` 强制。

---

## 8. 异步与生命周期

**浮空 Promise 是最高价值的 lint 类别** `lint` —— `no-floating-promises` `no-misused-promises` `await-thenable` `return-await`。刻意的 fire-and-forget 用 `void foo()` 标注。

**注册即可撤销的副作用** `人工` —— 启动子进程、监听器、定时器的一方同时拥有取消、等待和清理;`register()` 返回它的撤销函数;构造函数不启动无人管理的后台任务;teardown 等待相关工作静止。

**显式优于隐式** `人工` —— 默认值是显式的 `resolve(request): Spec` 步骤,不是藏在 `run()` 里的 `?? default`。部署会变的取值是校验过的配置字段;`DEFAULT_*` 常量不是可配置性。**配置错误响亮失败,永不静默跳过缺失的引用。**

---

## 9. SQL 与持久化

- 已提交的 migration 永不修改;live schema 变化用新的前向 migration `人工`
- 数据库类型从**活 schema 生成** `gen` —— Kysely + kysely-codegen。**SQL 是真相,类型是产物。不用 schema-first ORM。**
- **默认用 query builder** `test` —— 它的类型是从活 schema 生成的,列改了编译就断。
  只有两种情况可以手写整条 SQL,而且每一条都要有一句注释说明它是哪一种:

  ```
  不是查询          pg_notify · advisory lock —— builder 里没有对应物,
                    而且它们是过程调用,不是关于行的提问
  正确性就是 SQL     一条语句里同时写和读、要靠同一个快照,或者要走树。
                    用 builder 写出来,读的人还得在脑子里还原成 SQL
                    才知道锁范围和快照对不对 —— 那是更多要理解的,不是更少
  ```

  两条都由 `db/sql.spec.ts` 强制:**允许出现的整条语句是一张手改的名单**,加一条得有人特意去改。

- **SQL 只出现在 `db/`** `test` —— 路由里写查询,就是一条路由拥有了一个事实。同一个测试盯着。
- 查询名说明真实的状态转移,不叫 `updateState`
- 幂等、唯一 winner、名字唯一性由唯一索引强制;**迟到的写者必须在 SQL 里失败,不能只在 TS 里失败**
- 数据库时间拥有 lease、过期、顺序、重试和定时
- 有后果的外部提交在权限被消费之前或与之原子地记录
- 网络调用不放在数据库事务里

---

## 10. 测试

一个测试让**一条产品承诺或不变量无法抵赖**。

```ts
// 错:换个实现就红,产品承诺没被保护
expect(createWork).toHaveBeenCalledWith(expect.objectContaining({ agentId }))

// 对
render(<WorkPage workId={work.id} />)
expect(await screen.findByText('负责人 Mia')).toBeVisible()
```

必须覆盖的失败类别:**权限不足 · 输入畸形 · 准确重放与冲突重放 · 并发 winner · 授权过期 · 目标不可用 · 响应丢失后仍不猜测结果**。

每个节点在自己的 Issue 里冻结这一节点适用的具体场景。**本文件不维护跨功能的场景清单。**

---

## 11. 注释写决定,不写代码 `人工`

**代码说它做了什么,注释说为什么是这个而不是另一个。** 一行复述下面那行的注释,下次改代码时
没人会跟着改,于是它变成一句错话。

值得写下来的只有四种:

```
为什么不是另一个做法    被否掉的方案和否掉它的理由 —— 这是最常被重新提出的问题
换了会怎样             调换、省略、提前返回之后会发生什么,尤其是「不报错,只是答错」
外面逼出来的形状        NAT、SDK 的行为、协议、别人的 bug —— 读代码看不出来的约束
空 catch 吞了什么      见 5.2
```

**别用比喻。** 写 `contract` `boundary` `shape` 之前先问有没有更准的词。不解释语法。

注释可以长。一条决定需要三行才说得清就写三行 —— **省下的两行,下一个人要花半天重新推。**

---

## 12. 文档不复制代码真相 `人工`

文档不维护源码类型的逐字镜像。需要说明形状时,链接到拥有该事实的 schema 或源码符号;示例代码明确只是示例。

删除清单在关闭时对照完整 diff:声明删除的符号必须真的不存在。写法上区分「删掉这个符号」和「删掉这个符号里的某物」。

---

## 13. 工具链

具体的命令和生成器见 `repository.md`。**本文件只规定规则,不规定命令。**

---

## 14. 评审

**怎么看,见 `review.md`。** 本文件只规定规则,不规定评审的顺序与方法。
