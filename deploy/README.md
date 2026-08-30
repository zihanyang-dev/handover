# deploy

这一台机器上跑着的那份 Handover:它由什么组成、怎么发一次布。

**这里没有秘密。** 值住在服务器上的 `deploy/.env`,那个文件不进版本库,内容照仓库根的
`.env.example`。这里只有形状。

```
compose.yml    五个东西:postgres · 对象存储 · 建桶的一次性容器 · 应用 · Caddy
Caddyfile      唯一对外的那一层,证书它自己去要
release.sh     发一次布:拉代码 → 构建 → 应用迁移 → 起来 → 等它真的答话
```

## 为什么是这个形状

**一个 origin。** 页面和 API 同源不是偏好,是被逼的 —— 页面的调用不带自己的 origin,会话
cookie 是 `SameSite=Lax`,页面放在别处就等于每次调用都以未登录身份到达。所以 Caddy 后面只有
一个进程,它既发页面又答接口。见 `Dockerfile` 和 `docs/repository.md` 4.1。

**迁移在发布里,不在启动里。** 两个实例同时启动就会同时迁移,而失败一半的部署没有人说得清它
停在哪。`release.sh` 用一个只做这件事的容器把迁移跑完,再换掉在跑的那个。

**数据库和对象存储没有 `ports`。** 它们只在这张 compose 网络上有名字。开发用的那份
`compose.yml` 会把端口露出来,那是为了让人从笔记本连上去看——不是这里要的。

**`TRUSTED_PROXY_HOPS=1`。** 前面正好一层 Caddy。`repository.md` 点名说这是唯一一个填错了不
报错、只是静默失效的值:填 0 而前面有代理,发信限流就能被 `X-Forwarded-For` 绕过。

## 发一次布

```
ssh root@<机器>
/opt/handover/deploy/release.sh
```

## 第一次

需要人先做的,一样都不能少:

```
A 记录          指到这台机器
deploy/.env     照 .env.example 填;PUBLIC_ORIGIN 和 WEB_ORIGIN 都是那个域名
PUBLIC_HOST     Caddy 用它去要证书,就是域名本身,不带 scheme
OAuth 回调      在 Google / GitHub 那边登记 <PUBLIC_ORIGIN>/auth/<provider>/callback
Resend          发信域名要先在那边过 DNS 验证,否则只有账号持有人收得到信
```
