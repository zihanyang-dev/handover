# 把一件事交出去 —— 技术方案

`prd.md` 说的是「交办是一个开关」。这份文件回答:那个开关在库里是什么,以及一轮做完之后
**谁决定下一步**。

**这一片几乎不加东西,它推广已经有的东西。** 一段对话、一条消息、一轮工作、长轮询、三态、
实时流 —— 全部照旧。加一张表、改一个列名、在一条 `where` 里多一行。

---

## 一句话:一轮结束之后

```
03   一轮结束 → 没活了,等下一句问话
04   一轮结束 → 还有活,除非它在等,或者它完了
```

「有没有活」这个问题 `02` 就在问了,`03` 用「最后一句问话有没有人领」回答。这一片把答案换掉,
别的一律不动。

---

## 状态是一列,永远不从 transcript 推

一件事现在怎么样,读 `tasks.state`。**判断一个字都不看 transcript。**

这不是风格问题,是 `03` 已经定过的那条:

```
记录   messages     说了什么、做了什么。只追加,给人看
                    activityType 没有 check 约束 —— 一个新种类是一个值,不是一次发布
账     turns        哪一轮被谁领了、完没完。数据库裁决,值是封闭的
```

**拿记录当账用,后果是具体的:** 以后随便加一种新活动,所有在等的事就会悄悄「醒」过来,而且
没有任何东西会报错。再加上 Inbox 要跨 Space 查「在等我的」—— 靠往回翻消息推,每一段对话翻一遍,
建不了索引。

**carry 是同一个结论。** 它的 `Work` 分两样东西:`Lifecycle` 是存的(「还允不允许继续处理」),
`Activity` 是**派生的投影**(working / offline / failed / ready),在一条 `CASE` 里当场算出来。
而且 carry 的 `lifecycle` 出生时是 `open|paused|closed`,**下一个 migration 就砍成了
`= 'open'`** —— 一个状态枚举先设计再砍掉,那条路它替我们走过了。

所以这里存的是**没有任何别的事实能推出来的那一件**:agent 自己声明它停下来了。

---

## 四个值

```
working   该跑了
wait      在等你
sleep     在睡到某个时刻
done      完了
```

分界线是**谁会让它再动起来**:

```
working   不需要谁 —— 它就该在跑
wait      你
sleep     时钟
done      再也不会
```

**「在等子任务」不是一个值。** 它开出去的活还没完,那是关于**别的行**的事实 —— 数一下它的孩子
就知道。硬编码进状态列,才会多出那些值来。

```
不派活   state ≠ working  或者  它有没结束的子任务
Inbox    state = wait
页面      「它开了 2 件活」← 数一下
```

这样刚好解开一个绕不过去的尴尬:**它问了你一件事,同时还挂着两件子任务。**
`state=wait`(进你的 Inbox ✓)而且有未结束的子任务(不派活 ✓)—— 两个都为真,不打架,因为
它们本来就是两件事。

---

## 每个转换只有一个写入者,而且和「叫醒」是同一次调用

```
你点「交给它」                  → working    hand-over 端点
它说「我问你」                  → wait       它调的那个端点
它说「睡到 T」                  → sleep + sleep_until
一轮收成 failed / unknown       → wait       machineSays(一轮收尾本来就在这儿)
一轮收成 done / cancelled       → 不动它      它没说要停
你说话                          → working    sayTo
子任务结束                      → working    finish 端点顺手写父的
到点                            → working    叫醒器
它 finish / 你收回              → done + ended_at
```

**「变回 working」和「叫醒那台机器」做成一次调用** —— 和 `wakeMachine` 现在的位置一样。
**没法只叫醒不改状态,也没法只改状态不叫醒。**

**到点由叫醒器自己写:**

```sql
update tasks set state = 'working', sleep_until = null
 where state = 'sleep' and sleep_until <= now()
returning conversation_id
```

一条语句,走部分索引,只碰到点的那几行,然后叫醒那几台机器。这样 **`state` 永远字面为真** ——
读的时候不用再带一个时钟条件。

---

## 一轮不再必须回答一句问话

`03` 的 `turns` 是 `(conversation_id, asked_seq)`,`asked_seq` 指向一条**问话**。自驱的一轮没有
问话可指。

**推广,不新建:`asked_seq` 从「这一轮在回答哪一句问话」变成「这一轮是从第几条之后开始的」。**

对 `03` 来说那一条就是问话,一个字都不用改;对自驱的一轮,那一条是上一轮的收尾。主键还是
`(conversation_id, seq)`,外键还指向 `messages`,一轮只能被领一次仍然由数据库裁决。

**列名跟着改:`asked_seq` → `after_seq`。** 一个名字讲两件事,就是两件事里有一件会被读错。

---

## 数据

```
tasks
  id
  conversation_id   哪段对话
  parent_id         开它的那件事。null = 你交办的
  owner_user_id     谁负责
  goal              它复述、你点头的那句话。有界,进来就校验
  state             working | wait | sleep | done
  sleep_until       只有 sleep 时有值
  created_at · ended_at
  unique (conversation_id) where ended_at is null
  check  (ended_at is null) = (state <> 'done')
  部分索引 (sleep_until) where state = 'sleep'
  部分索引 (owner_user_id) where state = 'wait' and parent_id is null   ← Inbox

outputs
  id
  task_id
  key               agent 自己给的名字。同一个名字再写一次就是改它
  title · body      有界
  created_at · updated_at
  unique (task_id, key)

turns
  asked_seq → after_seq                                   ← 改名,别的不动
```

**`goal` 是一列,不是指向某条消息的指针。** 它是这件事的身份 —— 列表显示它、Inbox 显示它、
三天后回来还是它。carry 的 `works.goal` 就是一列,有界、进来就校验。

**为什么是一张表而不是 conversations 上几列。** 一段对话可以**先后**有好几件事(`prd.md` ⑨:
做完了再交办一次),那就是两件各有开始和结束的东西。而且「一段对话同时只能有一件没完的」是一条
conversations 表达不了的并发边界 —— 那条部分唯一索引就是它,由数据库拦着。

**`activityType` 加六个值,而且只记「人要看见的」:**

```
handed-over   从这里起它自己走
handed-off    它开了一件活(带子任务的 id)
handed-back   一件子任务有结果了(带它说的那句话)
asleep        它要睡到什么时候
finished      这件事结束了(带 done / cannot)
taken-back    你收回了
```

**没有 `asked`。** 它问你的那句话就是它说的话(一条 assistant 消息);「它在等你」是
`tasks.state`,不是 transcript 里的一行。**开放的那个集合不承载判断,承载判断的那个是封闭的** ——
上一版之所以看着无穷无尽,就是因为我让开放的那个去做判断了。

**大事记不建表。** 它就是这六种活动加上 `tasks` 那一行 —— 系统本来就知道,不用 agent 写一个字。

**不建**:`state` 之外的第二个枚举 · `wakes` 表 · 子任务计数列 · 预算的任何一列 ·
「它改过哪些文件」的任何一列(那是从命令行参数里猜的)。

---

## 决定

**① 交办是两步,因为目标该由要干活的那个写**

```
handover task propose "…"        它写一张卡片进 transcript
POST .../hand-over               你点「交给它」,这时才建 tasks 那一行
```

第一步只是一条活动,没有 task。第二步做三件事,一个事务:

```
写一条 activity  handed-over
建一行 tasks     goal 来自那张卡片,state = working
wakeMachine
```

**卡片上的那句话就是 `goal`,一个字不改。** 你点头的是它的复述 —— 那是这句话有资格当身份的
唯一理由。你按「不对」,什么都没建出来,接着聊。

**② 开子任务不用声明「我在等」**

`hand-off` 之后它接着做 —— 不然并行子任务开不出第二件。它这一轮结束时,孩子还没完就自然
不派活(上面那条规则)。所以**没有 `wait --for-subtasks` 这条命令**。

任何一件子任务结束,就往父的 transcript 追一条 `handed-back` 并叫醒父的机器 ——
**哪怕它还挂着另外两件**。父 agent 醒来自己判断是接着等还是往下走,我们不替它数还剩几件。

**③ 同一台机器上的子任务排队,而且不会死锁**

一台机器一次只干一件事 —— `02` 就有的规则,一个字不用改。

父任务把活交给同一台机器,那件子任务要等那台机器空出来。而父任务在等它 —— 死锁吗?**不。**
父任务那一轮已经收尾了,机器是空的,子任务当场被领走。

真正会排队的是**两件并行的子任务落在同一台机器上**:第二件等第一件。慢,但不会死。

**④ 一轮失败之后不自己重试,这条在服务端**

`prd.md` ⑧。做法不是「告诉 agent 别重试」——那是一条没有东西执行的规则。

做法是那张转换表里的一行:**一轮以 `failed` / `unknown` 收尾,`machineSays` 在同一个事务里把
这件事写成 `wait`。** 机器领不到活,所以它连重试的机会都没有。**机械化,不是嘱咐。**

**⑤ agent 改状态走 CLI,不走 SDK 的工具**

```
handover task propose "…"                  写一张卡片给人看
handover task ask "…"                      问负责人一件事,然后等
handover task sleep --until <时刻>          睡到那时候
handover task hand-off "…" --to <agent>    开一件子任务,接着做
handover task output --key <名> --title …   写一份产出,同名就是改它
handover task finish --done | --cannot "…"
```

`handover task --help` 列得出来,所以**它自己会用**,不用把命令表塞进 prompt 里再指望它记住。
一级 `handover --help`、二级 `handover task --help`,后面加东西不用改前面。

**为什么是命令行不是 MCP 工具。** 命令行两家都认,而且不需要在任何机器上装任何东西 —— 它就是
那台机器上已经跑着的那个二进制。一个只有一家支持的工具协议,等于把这一片绑在一个厂商上。

**它凭什么能调?** 常驻进程起 agent 的时候,把这段对话的 id 和一个只对它有效的凭据放进环境变量。
命令拿着它调那几个机器端点 —— 和常驻进程自己写消息用的是同一扇门。

**⑥ 交办中的每一轮都要告诉它它被交办了**

不然它答完一句就停了,因为它不知道自己该往下走。

那一轮的输入里带三样:**目标 · 到目前为止发生了什么(它自己就记得)· 你可以用这几条命令**。
**每一轮都带,不是只带一次** —— 一轮和一轮之间 agent 的会话可能接不上(`03` 决定⑨),接不上的
那一轮什么都不记得。

**⑦ 子任务的负责人是一个 agent,不是一个人**

`parent_id` 不为空 = 它的负责人是那段对话里的 agent。

于是 Inbox 就是一个查询:**`state = 'wait'` 且 `parent_id is null` 且 `owner_user_id` 是你**,
跨 Space。子任务问问题不会跑到你面前,不是因为我们过滤掉了,而是因为它问的本来就不是你 ——
它调 `ask` 的那个事务里,往父的 transcript 追一条 `handed-back` 并叫醒父的机器。

**⑧ 产出只收它自己声明的**

从工具调用里聚合「它改了哪些文件」听起来免费,实际是猜:`Edit` 认得出,`sed -i` 认不出,
`python -c` 更认不出。**猜不准的东西不该占一个固定位置假装权威** —— 这个仓库别处都不这么干
(没报过版本的机器不编一个版本,工具没说成没成不打勾)。

`key` 让它能改自己写过的那一份:一份三天的报告,它第一天写个开头,第三天补完 —— 同一个 key,
同一份东西。

**⑨ 「完了」是真的完了**

`state = 'done'` 且 `ended_at` 有值,这段对话就退回一段普通对话:它不再有活,你说话就是 `03`
的说话。

想让它再跑,再交办一次 —— **建的是新的一行**,上一件事原样留着。唯一能建出一行 `working` 的
地方就是 `hand-over` 那个端点,所以**没有任何一条路能让一件结束的事自己又动起来**。

---

## 三态出现在哪

照旧,一处不动。一轮还是 `done` / `failed` / `unknown` 三种收尾,`cancelled` 还是单独一种。

**这一片新增的是「事」的层,不是「轮」的层**,而两层同名的那个 `done` 要看清楚:

```
一轮 done   这一次它说完了,没出事    → 交办中的对话继续有活
事 done     它说这件事做成了          → 退回普通对话
```

`cannot` 和一轮 `failed` 也要分清:

```
一轮 failed   一次尝试没成,再试一次是安全的
cannot        它判断这件事做不成,再试没有意义
```

两个词分开是有代价的(多一个概念),但合并的代价更大:一件因为一次网络抖动而 `failed` 的事被
记成「做不成」,就再也没人会去看它了。

---

## 接口

```
POST /spaces/{slug}/conversations/{id}/hand-over    你点「交给它」。body: { key, goal }
POST /spaces/{slug}/conversations/{id}/take-back    收回。body: { key }
GET  /me/inbox                                      跨 Space,所有在等你的事

POST /machines/current/conversations/{id}/propose   它写一张卡片
POST /machines/current/conversations/{id}/ask       它问了负责人一件事
POST /machines/current/conversations/{id}/sleep     它要睡到什么时候
POST /machines/current/conversations/{id}/hand-off  开一件子任务,回子任务的 id
POST /machines/current/conversations/{id}/output    写一份产出
POST /machines/current/conversations/{id}/finish    done | cannot
```

机器那六个端点各写一条 activity(或一行 outputs)、各改一次状态、各自 `wakeMachine`,
和 `03` 那两个写入端点同一个形状。`/me/inbox` 是唯一一个不在 Space 下面的读 —— 因为它跨 Space,
这正是它存在的理由。

**机器问的还是两个问题,一个端点没加:**

```
有人要它停吗?     读 turns
有活给它吗?       读 turns + tasks
                  ├ 这台机器现在空着吗
                  ├ 这段对话最后一条还没人领吗
                  ├ 这段对话有一件 state = 'working' 的事吗   ← 04 加的
                  └ 它没有没结束的子任务                       ← 04 加的
                  条件在一条 where 里,不是几次往返
```

**长轮询、打断、实时流、adapter 一个字不动。**

---

## 风险

**没有上限,而且我们知道。** 一个每轮都「成功」却在原地转圈的 agent,没有任何东西会拦它。这是
`prd.md` 里写明的选择:拿「每一步都看得见 + 大事记就在右边」换。这一片结束之后**先看真实数据**
—— 一件事平均跑几轮、最长的那件跑了多少 —— 再决定上限该记什么。凭想象定一个数,是给人一种
有人在看着的错觉。

**Inbox 是唯一的刹车,所以它错一次的代价比别处大。** 一件在等你的事没出现在 Inbox 里,就是一件
永远不会再动的事。所以它是一个走部分索引的查询,而且判断的是同一列 `state` —— 两份实现总有一天
会不一致,而不一致的那一天你不会知道。

**状态转换的写入者散在六七个端点里。** 每一个都是「那件事发生的那个地方」,但它们只有靠
「改状态 = 叫醒机器 = 一次调用」这条来兜。**那一次调用必须是唯一的入口**,否则第七个端点会漏掉
一半 —— 这是这一片最需要机械化的地方,不是靠评审看出来的。

**「大事记」的六种活动是给人看的,不是给判断用的。** 这条规矩要写在类型旁边,不然下一个人会
顺手从里面推状态,然后我们又回到今天早上那一版。

**「睡到某个时刻」的精度是十秒,而且不承诺。** 机器不在线的时候到点,它回来才动。这和整个产品
其他地方一致(机器不在就是不在),但对「上线后三小时观察数据」这种事,值得在页面上说清楚。

---

## 测试

```
交办
  说「你自己做吧」→ 只写了一条卡片活动,没有 tasks 行
  点「交给它」    → 建了一行 working,goal 和卡片上一字不差
  点「不对」      → 什么都没建
  同一段对话交办两次(第一件没完)→ 数据库拒绝

自己往下走
  一轮 done 之后     → 又被派了一轮,不用任何人说话
  一轮 cancelled 之后 → 同上(你打断了,它接着走)
  一轮 failed 之后    → 没被再派活,state = wait
  一轮 unknown 之后   → 同上

停和醒
  它 ask       → state=wait;你说一句 → 当场 working 并被派活
  它 sleep(两秒)→ 两秒内没活;叫醒器把它改成 working 并叫醒机器
  它 sleep,然后你说话 → 当场醒,不等那个时刻
  叫醒器跑两遍  → 同一轮不会被领两次(turns 的主键)

子任务
  hand-off 之后没有别的声明 → 这一轮还能接着开第二件
  这一轮结束、孩子没完      → 不派活
  子任务 finish             → 父的 transcript 多一条 handed-back,父当场被派活
  子任务 ask                → 进的是父的 transcript,不是你的 Inbox
  两件子任务落在同一台机器   → 排队,不是并行,而且不死锁

产出
  同一个 key 写两次 → 一份,改掉了
  不同 key         → 两份

结束
  finish / 收回 → 不再有活;你说话就是普通的说话
  做完之后再交办 → 新的一行,上一件原样留着

不碰 03
  没交办的对话,一轮 done 之后 → 没活。这一片一个字都没改到 03
```
