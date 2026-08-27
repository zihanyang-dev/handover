# 多一个人 · 设计

`prd.md` 说这一片要什么。这里说它怎么建,以及每一处是照谁抄的。

## 数据

只加一张表,和两列。

```
invitations
  id · space_id · secret_hash 唯一   ← 和机器钥匙同一个形状:只存哈希
  made_by → users                    ← 谁请的
  expires_at · revoked_at            ← 会过期,能作废
  created_at
  一行 = 一条还能用或曾经能用的邀请链接

memberships
  space_id · user_id · request_key · created_at
+ role          'owner' | 'member'   ← 就两个值,check 约束钉死
+ revoked_at                         ← 移除写这个,不删那一行
  唯一(space_id, user_id)            ← 已经有了,再请回来就是把它放回去
```

**邀请复用机器钥匙的形状,不是巧合。** 两者回答同一个问题:让一个还没有身份的东西证明它被允许进来。
`02` 的 `enrolments` 已经是这个形状 —— 只存哈希、明文只出现一次、能作废、会过期、一次性 ——
所以这里不发明第二套,连措辞都对齐。

**没有 `invitations.email`。** 一条链接谁拿到都能用,这一点要写在人看得见的地方(`prd.md` ①),
而不是靠一个填了也不检查的字段假装它定向。
[Notion 的密钥链接也是这样:「把这条密钥链接复制给任何你想一起工作的人」](https://www.notion.com/help/add-members-admins-guests-and-groups)。

**`role` 是列不是表。** 两个值不需要一张表,而一张表会邀请第三个值。
[Linear 和 Notion 全平台都没有自定义角色](https://linear.app/docs/members-roles),
它们比我们大得多。WorkOS 把这条教训写成
[「别让角色爆炸,全局模型保持简单」](https://workos.com/blog/multi-tenant-permissions-slack-notion-linear)。

**`revoked_at` 而不是删行。**
[GitHub 保留三个月、Notion 三十天、Linear 干脆不给管理员永久删除的口子](https://www.stitchflow.com/user-management/linear/manual) ——
三家都把「移除」实现成撤销加一个能反悔的窗口。我们不设窗口的长度:那一行一直在,
再邀请就是把 `revoked_at` 清掉。**没有窗口,就没有一个到期之后突然不一样的日子。**

---

## 「至少一个 owner」由数据库说了算

这条规则有两个写入者(改角色、退出/移除),而两个写入者的规则由代码守就一定会漏。

```sql
-- 一个 Space 至少有一个没被撤销的 owner
create unique index memberships_one_owner_at_least on … -- 不行:唯一索引说的是「最多一个」
```

唯一索引说不了「至少一个」。所以这条走**一条延迟到事务结束才检查的约束**:退出、移除、降级
三条路都在自己的事务里做完,提交时才发现 Space 里没 owner 了,整笔回滚。

**代码里再拦一次是为了话说得好听** —— 拦住的时候要说
「你是这里唯一的 owner。先让另一个人也成为 owner,才能退出」,而不是一句约束名。
[GitHub 就是这么拦的:最后一个 owner 想走,它不让,并告诉你「一个组织至少要有一个 owner」](https://docs.github.com/en/enterprise-server@3.0/organizations/managing-organization-settings/transferring-organization-ownership)。

**为什么不是一个 owner 而是「至少一个」:**
[Slack 只有一个 Primary Owner,而它自己承认 owner 没转移就走了的时候「也许能帮忙,但不保证」](https://slack.com/help/articles/360038161033-Understand-the-Primary-Owner-role)。
一个会把所有人锁在门外的设计,不因为它简单就值得抄。

---

## 「不替你决定」怎么落成代码

移除一个人时,先算出**他名下还有什么**,一件一件交给人处理。

```
他还在跑的活    tasks where owner_user_id = 他 and ended_at is null
他的机器        machines where owner_user_id = 他 and removed_at is null
                其中「有人在用」= 这台机器上有没结束的对话
```

两样都是**读出来的,不是存的**,和这套代码里其它每一处一样。

**一件事换主人**是一列的写入(`tasks.owner_user_id`),而 Inbox 是查 `owner_user_id` 的,
所以通知自动跟着走 ——
[Devin 的定时任务是同一个做法:归属换了,通知跟着换](https://docs.devin.ai/product-guides/scheduled-sessions)。

**一台机器换主人**是 `machines.owner_user_id`,而它现在被一条复合外键钉在
`enrolments.approved_by` 上(「机器不能和批准它的人不一致」)。**换主人要连着改批准记录**,
或者把那条外键换成一条只说「主人存在」的约束 —— 见「要动的现有东西」。

**没有任何一条自动路径。** 移除一个人不会停掉他的活,也不会转移它们:
[Linear 不重新分配他开着的 issue](https://www.stitchflow.com/user-management/linear/manual)、
[Devin 的在跑 session 一直跑到自然结束](https://docs.devin.ai/enterprise/security-access/sso/guide)。
清单是产品,不是提示。

---

## 「机器不能和批准它的人不一致」怎么让开路

`20260906` 那条复合外键把 `machines.owner_user_id` 钉在 `enrolments.approved_by` 上。换主人要
改前者,而后者不能改 —— 所以这条约束要么让路,要么换主人做不成。

**定的是:它变成一条只在 `insert` 时检查的约束触发器。**

理由是这两列在这一片之前问的是同一个问题,之后不是了:

```
enrolments.approved_by     谁说的「可以」。发生过一次,然后就是历史
machines.owner_user_id     现在是谁的。会变
```

那条外键说的是「它们永远相等」,而真正值得守的规矩是「**它们在机器领凭据的那一刻相等**」——
也就是**一台机器不能出生在错误的人名下**。出生之后归属会动,那不是不一致,那是换了主人。

**为什么不是「代码保证插入时相等就行」:** 因为 `20260906` 自己写下的理由还成立 ——
`code-style.md` 9:迟到的写者必须在 SQL 里失败。所以它从外键变成触发器,不是从外键变成注释。
房子里已经有这个做法:`20260908` 那条「一个 Space 一开始就有 owner」就是一条约束触发器,
而且同样是 insert 也管。

**为什么不是改 `approved_by`:** 那是改历史。`prd.md` 05 ⑦ 承诺的正是反面 ——
他说过的话、他交办过的事,永远还写着他的名字。为了让一条约束好过而改一行历史,
是把这一片的承诺卖掉换一次迁移方便。而且 `approved_by` 全库只有一处读:机器领凭据时
给 `owner_user_id` 播种。它就是历史,没有别的身份。

---

## 换主人

两条接口,在下面的清单里。两条都收 `{ ownerUserId }`。

**一件事换主人是一列的写入**(`tasks.owner_user_id`),而 Inbox 查的就是这一列,所以通知自动
跟着走 —— [Devin 的定时任务是同一个做法:归属换了,通知跟着换](https://docs.devin.ai/product-guides/scheduled-sessions)。

**新主人必须是这个 Space 里没被撤销的成员。** 不然「转给…」会变成一条把东西转出这个
Space 的路,而那不是任何人想按的按钮。

**谁能按:这个 Space 的 owner。** 换主人这件事存在的理由是有人要走,而处理走人是 owner 的活
(`prd.md` ④)。「东西的现主人也能转给别人」现在**没有消费者**,按 `architecture.md` §2
那条「当前就有消费者」不建。

---

## 退出是自己的事,不是 owner 的恩准

`DELETE /spaces/{slug}/members/{userId}` 和它旁边那条 `…/held`,门是
**「你是这个 Space 的 owner,或者那个人就是你」**。

只挂 `requireOwner` 的话,一个 member 连走都走不了 —— 得求人把自己踢出去。
[GitHub 的做法是任何成员随时可以自己退出](https://docs.github.com/en/account-and-profile/how-tos/organization-membership/removing-yourself-from-an-organization),
唯一拦住的是最后一个 owner,而拦他的是那条「至少一个 owner」,不是权限。我们照做:
**权限拦的是「动别人」,不是「动自己」;拦最后一个 owner 的是数据库那条延迟约束。**

---

## 接口

```
POST   /spaces/{slug}/invitations          做一条链接;明文只回一次
GET    /spaces/{slug}/invitations          还能用的那些(不含明文)
DELETE /spaces/{slug}/invitations/{id}     作废

GET    /invitations/{secret}                这是哪个 Space、谁请的。要会话
POST   /me/spaces                           带着 secret 加入。「我多了一个 Space」

GET    /spaces/{slug}/members               谁在这儿,各是什么角色
PATCH  /spaces/{slug}/members/{userId}      改角色
DELETE /spaces/{slug}/members/{userId}      移除(自己退出也是这条)
GET    /spaces/{slug}/members/{userId}/held 移除之前:他名下还有什么

PATCH  /spaces/{slug}/conversations/{id}/task  一件事换主人
PATCH  /spaces/{slug}/machines/{id}            一台机器换主人
```

**加入是 `POST /me/spaces`,不是 `POST /spaces/{slug}/members`。** 发生的事是
「我的 Space 列表多了一个」,而 secret 是凭据不是路径的一部分 —— 和 `02` 的
`POST /me/machines`(认领一台机器)同一条道理:**创建的是「我和它的关系」。**

**`/invitations/{secret}` 要会话。** 不然一条链接就成了「这个 Space 存不存在」的探针,
而 `01` 承诺⑥说的是:**不存在和不是成员,同一个回答。**

---

## 要动的现有东西

```
memberships 长出 role 和 revoked_at        每一处读成员资格的地方都要排掉被撤销的:
                                          reachableFrom(机器可达性)· requireMember(那道门)
                                          machinesIn · waitingOn(Inbox)· 每一处 join

machines 的复合外键                        「机器不能和批准它的人不一致」在换主人时挡路。
                                          **定了:变成只在 insert 时检查。** 见下一节

01 的 design「不建:权限字段」              有消费者了(谁能邀请、谁能移除、谁能改名)。
                                          那句话要改成「只有两个角色,而且不会再多」

02 的「不属于任何人的机器」                 位置已经留了。这一片给了它触发条件:
                                          有人离职,而他名下的机器全队在用
```

**「排掉被撤销的」这一条是这一片最容易漏的地方,而且漏了不会报错** ——
一个被移除的人还能看见机器、还能收到 Inbox。所以它由一条机械规则守:
**每一处 `memberships` 的读都必须带 `revoked_at is null`**,一个测试扫全库,
和 `db/sql.spec.ts` 守裸 SQL 是同一个做法。

---

## 明确不建

```
invitations.email / 定向邀请    链接谁拿到都能用,这件事要说出来而不是假装
角色表 / 权限表                 两个值不需要一张表,一张表会邀请第三个值
移除的窗口期(30 天/3 个月)     那一行一直在,没有一个到期之后突然不一样的日子
审计日志                        有人问「这是谁干的」时再做
seat / 席位                     没有钱的概念之前它是空壳
```
