# 多一个人

`04` 的终点是**你交给它,然后走开**。这一片的终点是**你交给它,而别人也看得见**。

产品的第一句话是「责任从头到尾有两个具名持有人」。而到这一片开始为止,**一个 Space 永远只有一个人** ——
建它的那个。

## 为什么是现在

不是因为清单上排到了,是因为**代码里已经到处是为第二个人写的东西,而第二个人不存在**:

```
机器可达性是 join memberships 算出来的      为多成员写的
别人的机器上不显示「断开」按钮               为别人写的
每一行机器都标着「是谁的」                   因为一个 Space 里会有两个人的笔记本
Inbox 跨 Space                              为一个人在好几个 Space 里写的
```

这些都测过 —— 而测的时候**得直接往 `memberships` 表里插一行**,因为没有任何产品路径能让第二个人进来。
写了一堆没人能走到的路,是这一片存在的理由。

> **这一片只剩一半屏幕。** 拿着链接进来还在;邀请、停用链接、改角色、把人连同他的机器移出去,
> 都按不到。前端重构只做到「登录 → 建 Space → 连机器 → 和 agent 说话」这一刀,这些屏幕还没重做。
> 服务端全部实现、全部有测试,只是浏览器上按不到。欠账清单在 `rules/reachable.spec.ts` 的
> `NO_SCREEN_YET`,它只允许变短。

---

## 旅程

### ① 请一个人进来

Space 里生成**一条链接**,发给他。

```
邀请 mina 进 Acme
https://…/join/7f3a…                      [ 复制 ]
这条链接谁拿到都能进。不用了就把它作废。
```

**三种形状里只做链接这一种。** Notion 三种都有(邮箱、密钥链接、域名白名单),
[它的密钥链接是一条随时可以关掉的开关](https://www.notion.com/help/add-members-admins-guests-and-groups)。
邮箱那条要发信 —— 我们已经有发信,但邀请靠发信意味着**收不到信的人进不来**,而这是我们唯一
控制不了的一环。域名白名单是给有域名的公司的,现在没有那样的用户。

**这条链接和 `02` 的机器钥匙是同一个形状**:只存哈希、明文只出现一次、能作废、会过期。
不是巧合 —— 它们回答的是同一个问题:**怎么让一个还没有身份的东西证明它被允许进来。**

### ② 他点进来

没登录 → 先登录(`01` 那条路),登录完回到这条链接。
登录了 → 一句话:「Kai 请你加入 **Acme**」+ [ 加入 ]。

进来之后他看到的和别人一样:这个 Space 的机器、对话、Inbox。

### ③ 在里面,他能看到什么

**和你一样。** Space 里没有「只有我能看的对话」——
一个 Space 就是「这些人和这些机器一起干活的地方」,再往下切就需要一个我们还没有的理由。

唯一的差别是 `02` 已经写好的那条:**别人的机器上没有「断开」按钮。**
那是他的电脑,你能用,但拿不走。

### ④ 谁能做什么:两个角色,不能再多

```
owner    邀请人 · 移除人 · 改 Space 的名字 · 把别人也变成 owner
member   其余全部
```

**就两个,而且没有自定义角色。** 这不是省事,是照着抄的:
[Linear 全平台只有 Admin / Member / Guest,没有任何自定义角色](https://linear.app/docs/members-roles);
[Notion 任何档位都没有自定义角色](https://www.notion.com/help/whos-who-in-a-workspace)。
WorkOS 把两家的教训写成一句:**别让角色爆炸**,全局模型保持简单,变化推到边缘 ——
[Slack 早期的问题就是「一个角色的爆炸半径太宽」](https://workos.com/blog/multi-tenant-permissions-slack-notion-linear)。

**Guest 不做**,因为没有消费者:我们没有「只把这一段对话分享给某个人」这回事。

### ⑤ 一个 Space 可以有好几个 owner

**而且任何时候至少有一个。**

建 Space 的人是第一个 owner。他可以把别人也变成 owner,自己再退。

**这一条是照着一个真实的坑抄的。** Slack 只有一个 Primary Owner,而
[它自己的文档承认:如果 Primary Owner 没转移就走了,「Slack 也许能帮上忙,但这不是我们能保证的」](https://slack.com/help/articles/360038161033-Understand-the-Primary-Owner-role)。
单点 owner 是个会把人锁在门外的设计。

[GitHub 的做法直接拦](https://docs.github.com/en/enterprise-server@3.0/organizations/managing-organization-settings/transferring-organization-ownership):
最后一个 owner 想走,它不让,并告诉你「一个组织至少要有一个 owner」。我们照做。

> 你是这里唯一的 owner。先让另一个人也成为 owner,才能退出。

`01` 里那条「永远不能断开最后一条路」是同一条规矩,低一层。

### ⑥ 让人走 —— 是一张清单,不是一个按钮

按下「移除」,先看到**他名下还有什么**:

```
把 mina 从 Acme 移除

她还有 2 件事在跑
  盯三天转化数据            在跑 · mina-mbp        [ 转给… ] [ 停掉 ]
  补一个集成测试            在等她 · build-server-1 [ 转给… ] [ 停掉 ]

她的机器,这里有人在用
  build-server-1           2 段对话在上面跑         [ 转给… ]
  mina-mbp                 没人在用

                                        [ 移除 ]
```

**我们不替你决定这些。** 这是照着两家抄的,不是偷懒:
[Linear 明说移除一个人不会重新分配他开着的 issue,得管理员自己去转](https://www.stitchflow.com/user-management/linear/manual);
[Devin 的 SSO 下线说得更直白:正在跑的 session 会一直跑到它自然结束,没有即时吊销这回事](https://docs.devin.ai/enterprise/security-access/sso/guide)。

我们本来就有一条同样的硬规矩:**一轮失败它不自己重试,因为要有人判断。** 人走了也一样。

所以移除给的不是一个动作,是**一份要处理的清单** ——
[Tailscale 就是这么写进 offboard 流程的:删人之前,把需要的设备转给别人,并确认要留的 key 还能用](https://tailscale.com/docs/features/sharing/how-to/offboard)。

**一件事换主人**,新主人的 Inbox 里就有了它 ——
[Devin 的定时任务有先例:归属换了,通知也跟着换到新主人那儿](https://docs.devin.ai/product-guides/scheduled-sessions)。

**他的机器有两条路**:转给另一个人,或者**变成不属于任何人的机器**(`02` 留的那个位置)。
[Tailscale 的教训是硬的:删掉用户就删掉他的设备,连接直接被阻断](https://tailscale.com/docs/features/sharing/how-to/remove-team-members) ——
所以团队那台构建服务器不该挂在某个人名下。

### ⑦ 他走了之后

**他说过的话、他交办过的事,永远还写着他的名字。**
[Linear:他建的、他名下的东西全留着并且仍然归属于他](https://linear.app/docs/members-roles);
[GitHub:他的 PR、issue、评论原封不动,归属不变](https://docs.github.com/en/enterprise-cloud@latest/organizations/managing-membership-in-your-organization/removing-a-member-from-your-organization)。

这和我们「记录 vs 账」那条分法本来就是一回事:transcript 是发生过的事,发生过就不改。

**移除是可以反悔的。** 三家都给了一个窗口:
[GitHub 存 3 个月](https://docs.github.com/en/enterprise-cloud@latest/organizations/managing-membership-in-your-organization/removing-a-member-from-your-organization)、
[Notion 30 天内回来全恢复](https://www.notion.com/help/add-members-admins-guests-and-groups)、
[Linear 干脆只停用、不给管理员永久删除的口子](https://www.stitchflow.com/user-management/linear/manual)。

我们取最简单的一种:**移除写的是「什么时候撤销的」,不是删掉那一行。** 同一个人再被邀请进来,
就是把那一行放回去。

**有一样我们要不回来:他机器上的东西。**
[GitHub 说得最诚实:「确保失去访问的人删掉机密信息,是你的责任」](https://docs.github.com/en/enterprise-cloud@latest/organizations/managing-membership-in-your-organization/removing-a-member-from-your-organization) ——
那是他的电脑。我们能做的是让他的凭据立刻失效,并且说清楚我们只能做到这里。

---

## 承诺

```
① 一条链接就能请人进来。链接能作废,会过期,明文只给你看一次
② 进来的人看到的和你一样 —— 除了他不能断开别人的机器
③ 角色只有两个,而且永远不会长出第三个
④ 任何时候至少有一个 owner。最后一个想走,先交给别人
⑤ 移除之前,你会先看到他名下还有什么,一件一件自己决定
⑥ 我们不替你停掉、也不替你转移任何在跑的东西
⑦ 他说过的话和他交办过的事,永远还写着他的名字
⑧ 移除可以反悔:再请他进来,他原来的一切都还在
⑨ 他的凭据当场失效。他机器上已经有的东西我们要不回来 —— 这一点我们说出来,不装作能
```

---

## 完成标准

```
生成一条邀请链接 → 明文只出现一次,再看要重新生成
把链接发给第二个人,他点开 → 没登录先登录,登录完回到这条链接
他点加入 → 进到这个 Space,看到同样的机器和对话
他的机器接进来 → 第一个人在这个 Space 里看得见,而且标着是他的
第一个人想断开他的机器 → 没有那个按钮
把链接作废 → 再点就说这条邀请不能用了
链接过期 → 同上,措辞不同
member 想邀请人 → 没有那个入口
member 想移除人 → 没有那个入口
owner 把 member 变成 owner → 两个 owner
唯一的 owner 想退出 → 被拦住,并告诉他先让别人也成为 owner
移除一个人 → 先看到他名下 2 件在跑的事和他的机器
把一件事转给另一个人 → 那件事出现在新主人的 Inbox 里
把一台机器转给另一个人 → 它还在这个 Space 里,标着新主人
移除之后 → 他的会话立刻不能用了,而他说过的话还在,还写着他的名字
把同一个人再请进来 → 他原来的东西都还在
```

---

## 不在这一片

```
Guest / 只分享一段对话     没有消费者。真有「只给他看这一段」的需求时再说
自定义角色                 Linear 和 Notion 全平台都没有,而它们比我们大得多
邮箱邀请 / 域名白名单       链接够用。收不到信的人进不来,是我们控制不了的一环
组织 / 计费 / 席位          没有钱的概念之前,席位是个空壳
审计日志                   谁在什么时候做了什么 —— 有人问起「这是谁干的」时再做
人交给人                   `04` 里那条:把一件事交给另一个人,而不是另一个 agent。
                           它需要这一片先存在,但它是下一片
把两个 Space 合成一个       和 `01` 里「把两个账号合成一个」同一类,需要的东西比这一片多
```
