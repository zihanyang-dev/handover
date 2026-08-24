# 登录与 Space —— 技术方案

对应 `prd.md`。只写这一片要建的东西。

## owner

| owner      | 拥有                                             | 恢复错误                                   |
| ---------- | ------------------------------------------------ | ------------------------------------------ |
| `identity` | User、已验证地址、登录方式、验证挑战、浏览器会话 | 码不对 / 过期 / 已用 / 试太多 / 挑战不存在 |
| `space`    | Space、显示名、slug 归一化规则、成员关系         | 名字无效 / slug 冲突 / 幂等冲突            |

`space` 不知道邮箱和会话。`identity` 不知道 Space。

## 数据

```
users
  id · display_name · created_at
  账号本身没有内容。它不是一个地址,也不是某个提供商那边的账号

email_addresses
  user_id · address 唯一 · verified_at
  唯一(address)              ← 一个地址只属于一个账号,这是整套并入规则的支点
  一个账号可以有多行。最早的那行是显示用的那个,不存"主地址"这个状态

sign_in_methods
  user_id · kind(google|github) · subject · linked_at
  唯一(kind, subject)          ← 一个提供商账号只能连一个 User

email_challenges
  id · email · purpose(sign-in|attach) · code_hash · expires_at · attempts
  closed_at + closed_reason(consumed|superseded)   两个一起有,或一起没有
  request_key 唯一           ← 发码的幂等键
  唯一(email, purpose) where closed_at is null     ← 一个地址每种用途只有一封开着
  purpose 是钥匙的用途,不是它的强度:登录的码不能拿去绑定,反过来也不行
  过期不进谓词:Postgres 要求索引谓词 IMMUTABLE,now() 不是。过期由读判定

browser_sessions
  id · user_id · created_at · expires_at · revoked_at
  token_hash 唯一            ← 唯一的查询入口;cookie 里是随机原串,库里只有哈希

spaces
  id · display_name · slug 唯一 · created_at

memberships
  space_id · user_id · created_at
  唯一(space_id, user_id)
  request_key 唯一           ← 建 Space 的幂等键,挂在成员关系上
```

**不建**:权限字段(没有消费者)· 最近访问 · 断开的记录 · `email_addresses.is_primary`
(按 `verified_at` 取最早的就够,一个能和事实不一致的状态没有理由存)。

## 决定

**① 身份是 `users.id`,所有登录方式都只是挂在它上面的钥匙**

`sign_in_methods` 记住提供商那边的稳定 `subject`(不是地址)——用户以后在那边改邮箱,链接不断。
`email_addresses` 记住每一个验过的地址。两张表地位相同。

**没登录时**,一把钥匙要找到账号,靠的是这个顺序:

```
1. (kind, subject) 命中      → 那个账号。地址后来变了也不影响
2. 交回的地址命中 address    → 那个账号,并且把这把钥匙挂上去   ← 并入发生在这里
3. 都不命中                  → 新账号 + 这个地址 + 这把钥匙
```

第 2 步是整套设计里唯一一处「没证明自己是账号主人,却进了一个已有账号」。它成立的理由只有一条:
**提供商交回的是它已验证的地址,而验证一个地址正是邮箱验证码在做的事**,同一个标准,不更弱。
`email_addresses.address` 的唯一索引是这条规则的支点 —— 一个地址两个账号,第 2 步就没有答案。

**已经登录时连一把钥匙,不看地址。** 会话已经证明了主人身份,再要求地址一致保护不了任何东西 ——
那个要求是从"账号就是它的地址"里继承来的,而账号不再是它的地址了。这时只剩一个问题:这把钥匙
是不是已经属于别人。

**连提供商不顺手收编地址。** 收编意味着把一个地址从别的账号搬过来,那是接管账号的原语。
想让一个地址也能进这个账号,就走绑定:发码、验、写一行。**两件事,两个动作。**

**绝不对未验证的地址做以上任何一件事。**

**② 发信这个外部后果,在验证码可用之前就记下来**

```
begin → 按邮箱取 advisory lock            同一地址的请求排队,包括它自己的重试
      → 按 request_key 查重放,命中就返回   ← 必须在作废之前,否则它作废掉自己要返回的那条
      → 作废这个邮箱其他还开着的挑战
      → 写新挑战(含 code_hash)
      → commit
然后才发信。发信失败或结果未知,挑战仍然有效,用户可以重发。
```

锁按地址加用途,和那个部分唯一索引一致:开着的挑战是**每个地址每种用途一条**,不加锁两个请求会一起撞上它。

发信本身不在事务里。**响应丢了重试同一个 `request_key`,拿到同一个挑战,所以只发一封。**

**③ slug 归一化住在 `space` owner,浏览器直接 import**

一个纯函数:`normalizeSlug(displayName): string`。前端实时预览跑的就是它,**不产生第二份真相,也不需要预览接口**。

前端的预览不是权威。服务端照样归一化并校验,唯一索引照样裁决。

**④ 建 Space 的 winner 由唯一索引给**

不先查再插。

```
begin → 按 request_key 取 advisory lock   只和自己的重试排队
      → 查重放,命中就返回同一个 Space
      → 插入 space,撞 slug 唯一索引就 do nothing
      → 插入 membership
      → commit
```

锁按 request_key,所以「slug 已被占」只有一个含义:**别人占的**。自己的重试进不到那一步。

slug 冲突时,服务端算下一个数字后缀作为**建议**。建议不预留,再提交仍可能冲突。

锁序:`spaces → memberships`。

**⑤ 会话住在 PostgreSQL,不引入 Redis**

httpOnly + Secure + SameSite=Lax 的 cookie 里是随机令牌,服务端只存 `token_hash`。读路径是一次点查:

```sql
where token_hash = $1 and revoked_at is null and expires_at > now()
```

不引入 Redis 的理由不是性能,是权威。会话放外部缓存,「这个会话还有效吗」就不再由数据库裁决 —— PG 里撤销了而缓存里那份还在,**被撤销的会话仍然能用**。那是安全缺陷,不是一致性瑕疵。

**会话行写一次读多次。** 请求路径上不写这张表(不更新 `last_used_at` 之类),否则一次廉价的读会变成一次写。要滑动过期,最多每 N 分钟写一次。

清理任务只管表大小 —— 过期和撤销都由读判定,清理挂了不会留下一个还能用的会话。

**⑥ 「怎么进来」是读出来的,不是存出来的**

两次查询:`email_addresses` 里的每一行各是一条路,`sign_in_methods` 里的每一行各是一条路,
这个部署没有钥匙的提供商列成「可以去连接」。**不存"这个账号支持哪几种"这样的状态。**

地址是**一条一条列的**,不是折成一句「邮箱验证码可用」。折起来就看不出有几把钥匙,而
「有几把钥匙」正是这一段存在的理由。

断开这一片不做,但约束先写下:**永远不能断开最后一条路**,地址也算路 —— 账号不再等于某一个
地址,所以最后一个地址和最后一个提供商一样是可以被断到零的,必须挡。

**⑦ 「不可用」是一个回答,不是两个**

按 slug 读 Space 时,同一条查询要求当前会话在这个 Space 有成员关系。slug 不存在和不是成员,走同一个分支、同一个错误。

## 三态出现在哪

这一片只有一处外部后果:**发信**。

```
succeeded  已投递给邮件服务
failed     邮件服务明确拒绝     → 用户可以重发
unknown    没拿到确认           → 挑战有效,用户可以重发;重发用同一个 request_key,不会变成两封
```

## 接口

```
GET   /auth/ways-in                      → 这个部署能提供哪几种。不要会话
POST  /auth/{provider}/start             → { url },浏览器自己去
GET   /auth/{provider}/callback          → 建会话,跳回 WEB_ORIGIN + next
POST  /auth/email/challenges             幂等键;→ 挑战 id · 何时过期 · 何时可重发
POST  /auth/email/challenges/{id}/verify → 建会话
DELETE /browser/sessions/current

GET   /me                                → User · 怎么进来 · 他的 Space 列表
PATCH /me                                → 改 display_name
POST  /me/sign-in-methods/{provider}/start → { url },连一个提供商到当前账号
POST  /me/email-addresses/challenges       幂等键;→ 挑战 id · 何时过期 · 何时可重发
POST  /me/email-addresses/challenges/{id}/verify → 把这个地址加到当前账号
POST  /spaces                            幂等键;→ Space,或带建议的冲突
GET   /spaces/{slug}                     → Space,或「不可用」
```

`start` 返回地址而不是 302:页面用 `fetch` 读不到重定向的目标(浏览器藏起来了),
而跟着走会把请求本身送去提供商,而不是人。导航是浏览器的事。

**契约从路由本身导出**,不是另写一份:zod 是真相,OpenAPI 是 `pnpm generate` 的产物,
浏览器的客户端再从它生成。`pnpm check` 断言三者无 diff。

## 测试

**owner 行为**:slug 归一化(空白、大小写、非 ASCII、超长、纯符号)· 五种验码失败各自的错误 · 显示名初始值的三条来源 · 「怎么进来」在零个到多个地址、零条到两条提供商链接下列出什么。

**真实数据库**:

```
同一 request_key 并发发码 → 一个挑战,一封信
发新码作废旧码,旧码报「已过期」不是「不对」
同一个地址的登录码和绑定码互不作废,也不能互相顶用
两个账号同时绑同一个地址 → 一个成功,一个明确被拒
同一 request_key 并发建 Space → 一个 Space,一份成员关系
两个不同 request_key 同名并发 → 一个成功,一个拿到冲突与建议
```

**浏览器旅程**:

```
三种入口各进一次
同邮箱先 Google 后验证码 → 同一账号,Space 都在,并且看到并入提示
连上 GitHub 之后,下次登录不再要验证码
用 Google 登进来再绑一个不同的邮箱 → 两条路都进同一个账号
绑一个已属于别人的地址 → 明确拒绝,两边账号都没变
连一个已连在别人账号上的 GitHub → 明确拒绝,账号没变
连接失败的每一种,页面上都说了原因
杀掉发码响应 → 重试后邮箱里只有一封
杀掉建 Space 响应 → 重试后只有一个 Space
访问不属于自己的 slug → 「不可用」
会话过期 → 登录后回到原 URL
```

**错误恢复证据**:transport 行为测试逐一断言五种验码失败的公开说明与恢复动作;另有测试证明 slug 不存在和不是成员得到同一个「不可用」。不写扫描错误名或公开文案的业务门禁。
