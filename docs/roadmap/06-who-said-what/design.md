# 谁说的 · 设计

> **这一片还没实现。** 冻结在前,实现在后。做完把这一行删掉。

`prd.md` 说这一片要什么。这里说它怎么建,以及每一处是照谁抄的。

## 数据

**一张表加一列,不加表。**

```
messages
  seq · role · content · conversation_id · key · created_at
+ said_by → users   可空          ← role='user' 时是那个人,其余三种为空
```

**不是 `(author_type, author_id)`。** [Multica 的 `comment` 表是那个形状](https://github.com/multica-ai/multica)
(`author_type CHECK ('member','agent')` + `author_id`),而我们不需要 `author_type` ——
`transcript.ts` 里的词汇表本来就是它:

```ts
const FROM = { person, agent, tool, nobody } // role 就是「这行是谁写的」的种类
```

再加一列 `author_type` 就是同一个事实的第二份,而且两份会不一致。

**这一列必须可空,而这是抄来的教训。** Multica 后来要加平台自动发的行,
[它的迁移 107 写着](https://github.com/multica-ai/multica):

> the platform can post a comment **without attributing it to a member or agent**.
> system rows use a **zero UUID** for author_id (the column is still NOT NULL).

`NOT NULL` 逼出了一个零 UUID 哨兵,而哨兵是一个会被当成真值读出去的假值。
我们四种行里有三种本来就没有人,所以这一列从第一天起就可空。

### 「有名字」和「是人说的」不能不一致

```sql
alter table messages add constraint messages_a_person_has_a_name
  check ((role = 'user') = (said_by is not null)) not valid;
```

一个 `role='user'` 而没有名字的新行,和一个 `role='assistant'` 却挂着人名的行,都要在 SQL 里失败。
`code-style.md` 9:**迟到的写者必须在 SQL 里失败。**

**`not valid` 是这一片的关键字。** 它的意思正好是我们要的:**旧行不检查,新行一律检查。**
这一片之前写下的 `user` 行没有作者,补不出来 —— 它们留在那儿,而从今天起不可能再产生一行。
(`not valid` 不是「不生效」:插入和更新照样被拦,只是不回头扫全表。)

### 「这段对话是谁开的」不存

它是**第一句人话的作者**,一次索引查得到。`架构` §2:**派生而非存储。**
存一份 `conversations.started_by` 就是第二份真相,而它会和第一句话的作者不一致 ——
比如那句话被移除的人说的,而列表上写着另一个名字。

---

## 一轮带走上一轮之后所有人说的话

现在 `beingAsked` 是:

```sql
select ... from messages m
 where m.conversation_id = c.id and m.role = 'user'
 order by m.seq desc limit 1        -- ← 只要最后一句
```

`limit 1` 是为一个人写的,而且那时是对的。第二个人一出现它就丢消息 —— `prd.md` 里量过。

改成:**上一轮结束之后的每一句人话,按 seq 升序。**
[Slack 里两个人 @ 同一个 bot,两句都送到](https://slack.com/help/articles/33076000248851-Work-with-AI-agents-in-Slack)。

不重排、不合并、不去重:它们本来就是先后说的,顺序就是意思的一部分。

### 线上的形状要改,而且顺便简化了一处

```
现在   asked: { text, model?, effort? } | null       每一句自带 model 和 effort
之后   asked: { text, who: string | null }[]         一轮里的每一句,和它是谁说的
       model?: string   effort?: string              升到一轮上,取最后一句说了的那个
```

**`model` / `effort` 本来就不该在每一句上。**一轮只跑一个模型,而它们在每一句上出现,
是因为过去一轮只有一句。两个人各选了不同的模型时,这一列必须有一个答案 ——
**最后说话的那个人的选择**,和「最后一句是这一轮的由头」是同一条规矩。

**`who` 是名字,不是 id。**机器那边没有人的表,拿到 id 也没用;而它要把这几句话拼进 prompt,
拼进去的必须是人能读的东西。这一片之前的行没有名字,`who` 是 `null`。

**改线上的形状会打断已经装出去的 CLI。**现在没有外部使用者,`AGENTS.md`
「发第一个 tag 之前:地基优先于影响面」说的就是这种时候:改干净,同一次改动里把每一处都改掉。

---

## 「谁在输入」走那条不落库的通道

`03` 已经建好了这条路:`conversation/live.ts` 的 `Watched` 走 SSE,
`db/live.ts` 用 `pg_notify` 跨实例,**什么都不写进 transcript**。

「Mina 正在输入」和「它正在想什么」是同一类东西:不是事实,是此刻的样子,连接断了就没了。

```
Watched  = { seen: 'moment', moment: Unkept }
         | { seen: 'written', upTo: number }
       + | { seen: 'typing', who: string }        ← 新增一支,who 是名字
```

**新增一条只发不存的路:**

```
POST /spaces/{slug}/conversations/{id}/typing     什么都不返回,什么都不写
```

**没有「停止输入」这条路,而且不能有。**浏览器关掉、网断了、人走开了 —— 这三件事都发不出
「我不打了」。所以做法是[和 Slack 一样的心跳](https://slack.com/help/articles/33076000248851-Work-with-AI-agents-in-Slack):
**在打字的那一端每隔几秒发一次,看的那一端过一小会儿没再收到就自己收起来。**
服务端不存任何状态,因此也没有任何状态会泄漏。

---

## agent 不能冒充人

```
现在  POST /machines/current/conversations/{id}/messages   body 收完整的 Message 联合
                                                            —— 里面含 role: 'user'
之后  只收 assistant / tool / activity
```

`transcript.ts` 已经把四种拆成了 `FROM`,所以这是一个三选一的联合,不是一个新概念:

```ts
export const Reported = z.discriminatedUnion('role', [FROM.agent, FROM.tool, FROM.nobody])
```

**人说的话只有人那条路能写,而它的名字来自会话,不来自 body。**
一个从 body 里读作者的接口,等于让调用方声明自己是谁。

[Copilot 把不是它写的补全标成了自己,被称作「AI 归属变成信任问题」](https://www.penligent.ai/hackinglabs/vs-code-copilot-co-author-when-ai-attribution-becomes-a-supply-chain-trust-problem/) ——
**一个能被伪造的名字比没有名字更坏**,因为人会信它。

CLI 从来没发过 `user` 行,所以这一刀不切到任何真实用法。

---

## 接口

```
POST   /spaces/{slug}/conversations/{id}/typing        我在打字。不返回,不落库

改动:
GET    /spaces/{slug}/conversations/{id}               每行人话多一个 said(名字或 null)
GET    /spaces/{slug}/conversations                    每行多一个 startedBy(名字或 null)
GET    /spaces/{slug}/conversations/{id}/live          Watched 多一支 typing
POST   /machines/current/poll                          asked 变成一轮里的几句 + who
POST   /machines/current/conversations/{id}/messages   只收三种 role
```

---

## 要动的现有东西

```
messages 长出 said_by            四处写 message 的地方里,只有 sayTo 那一处要填

beingAsked 的 limit 1            改成「上一轮之后的全部」。它是 takeOne 那条手写 SQL 的一部分,
                                 而那条 SQL 在 rules/sql.spec.ts 的白名单里 —— 改它要连着改说明

Asked 在线上的两个方向            进来的还是一句(人发的),出去的变成一轮(机器收的)。
                                 这两个方向本来就不是同一个东西,现在名字上也分开

reportingBody 收窄               同一次改动,见上

apps/cli/src/answering.ts        把几句话拼进一次 prompt。谁说的要拼进去,否则 agent 拿到
                                 两句不知道来自两个人的问题

conversation.tsx / conversations.tsx   显示名字
```

---

## 明确不建

```
锁输入框                   prd ④。Google Docs / Confluence 都不锁,而且它防不住真正丢消息的那件事
author_type 列             role 就是它。第二份会不一致
conversations.started_by   派生得到。存一份就会和第一句话的作者对不上
zero UUID 哨兵             Multica 迁移 107 的教训,我们从第一天就让这一列可空
「停止输入」接口            浏览器崩了发不出它。心跳 + 自己收起来,服务端零状态
按对话推断旧行的作者        `03` ⑤:「不知道」永远不被猜成别的
@ 某个人 / 已读 / 头像      见 prd「不在这一片」
```
