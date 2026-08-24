# 登录与 Space —— 技术方案

对应 `prd.md`。只写这一片要建的东西。

## owner

| owner      | 拥有                                             | 恢复错误                                   |
| ---------- | ------------------------------------------------ | ------------------------------------------ |
| `identity` | User、已验证邮箱、登录方式、验证挑战、浏览器会话 | 码不对 / 过期 / 已用 / 试太多 / 挑战不存在 |
| `space`    | Space、显示名、slug 归一化规则、成员关系         | 名字无效 / slug 冲突 / 幂等冲突            |

`space` 不知道邮箱和会话。`identity` 不知道 Space。

## 数据

```
users
  id · verified_email 唯一 · display_name · created_at

sign_in_methods
  user_id · kind(google|github) · subject · linked_at
  唯一(kind, subject)          ← 一个提供商账号只能连一个 User
  邮箱验证码不进这张表:谁控制这个邮箱谁就能拿到码,它不是"连上去"的

email_challenges
  id · email · code_hash · expires_at · attempts
  closed_at + closed_reason(consumed|superseded)   两个一起有,或一起没有
  request_key 唯一           ← 发码的幂等键
  唯一(email) where closed_at is null              ← 一个地址只有一封开着
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

**不建**:权限字段(没有消费者)· 最近访问 · 断开的记录。

`users.verified_email` 以后会变成 `user_emails` 表(一个账号多个邮箱),**这一片一列就够**,到时候一次前向 migration。

## 决定

**① 身份锚点是已验证邮箱,不是登录方式**

三种入口都先拿到一个已验证邮箱,再按邮箱找 `users`:找到就登它,没有就建。`sign_in_methods` 记住提供商那边的稳定 `subject`(不是邮箱)——用户以后在那边改邮箱,链接不断。

**绝不对未验证邮箱做这件事。** 我们没有这个状态:三种入口都验证过。

**② 发信这个外部后果,在验证码可用之前就记下来**

```
begin → 按邮箱取 advisory lock            同一地址的请求排队,包括它自己的重试
      → 按 request_key 查重放,命中就返回   ← 必须在作废之前,否则它作废掉自己要返回的那条
      → 作废这个邮箱其他还开着的挑战
      → 写新挑战(含 code_hash)
      → commit
然后才发信。发信失败或结果未知,挑战仍然有效,用户可以重发。
```

锁按地址,不按 request_key:开着的挑战是**每个地址一条**,不加锁两个请求会一起撞上那个部分唯一索引。

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

那一段是一次查询:`sign_in_methods` 里有什么 + 邮箱验证码恒为可用。**不存"这个账号支持哪几种"这样的状态。**

断开这一片不做,但约束先写下:**永远不能断开最后一条路**,而且邮箱验证码不算"一条可断开的路"。

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
POST  /auth/{google|github}/start        → 跳转
GET   /auth/{google|github}/callback     → 建会话,回到 next
POST  /auth/email/challenges             幂等键;→ 挑战 id
POST  /auth/email/challenges/{id}/verify → 建会话
DELETE /browser/sessions/current

GET   /me                                → User + 他的 Space 列表
PATCH /me                                → 改 display_name
POST  /me/sign-in-methods/{kind}/start   → 跳转,连一个提供商到当前账号
POST  /spaces                            幂等键;→ Space,或带建议的冲突
GET   /spaces/{slug}                     → Space,或「不可用」
```

wire 类型与 zod 从 OpenAPI 生成。

## 测试

**owner 行为**:slug 归一化(空白、大小写、非 ASCII、超长、纯符号)· 五种验码失败各自的错误 · 显示名初始值的三条来源 · 「怎么进来」的三种状态组合。

**真实数据库**:

```
同一 request_key 并发发码 → 一个挑战,一封信
发新码作废旧码,旧码报「已过期」不是「不对」
同一 request_key 并发建 Space → 一个 Space,一份成员关系
两个不同 request_key 同名并发 → 一个成功,一个拿到冲突与建议
```

**浏览器旅程**:

```
三种入口各进一次
同邮箱先 Google 后验证码 → 同一账号,Space 都在,并且看到并入提示
连上 GitHub 之后,下次登录不再要验证码
连一个邮箱不同的 Google → 明确拒绝,账号没变
杀掉发码响应 → 重试后邮箱里只有一封
杀掉建 Space 响应 → 重试后只有一个 Space
访问不属于自己的 slug → 「不可用」
会话过期 → 登录后回到原 URL
```

**错误恢复证据**:transport 行为测试逐一断言五种验码失败的公开说明与恢复动作;另有测试证明 slug 不存在和不是成员得到同一个「不可用」。不写扫描错误名或公开文案的业务门禁。
