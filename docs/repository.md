# Handover 仓库

拥有:目录、生成物边界、命令、CI、删除纪律。

## 1. 根目录

```
Dockerfile          服务器 + 它托管的那些页面,一个镜像
apps/server/        API
  src/<owner>/      一个事实 owner 一个目录,一个文件一条行为
                    住在这里的是 db/ 和 server/ 都要用、而谁都不该拥有的那些
  src/db/           持久化边界
  src/server/       入站传输
  scripts/          生成器与仓库维护脚本
  migrations/       已提交的永不修改
  generated/        生成物,永不手改
apps/web/           浏览器应用
  features/         一块屏幕上的一件事
  routes/           地址到屏幕
  components/ui/    没有主人的视觉零件:一段手写体、一次礼花、一层渐变模糊
                    进这里的标准是「它不知道 Handover 是什么」
  lib/              同上,但不是零件:目前只有拼 class 名的 cn
  mark.tsx mark.css 那个标识,和它的几种状态;关键帧留在相邻的 CSS
  style.css         Tailwind 入口、theme,和语义化的 component utilities,整个产品一份
  pretend/          屏幕测试里冒充服务器的那几个:/me、一个 Space、登录方式、EventSource
apps/cli/           装在机器上的那个命令
  src/              一个文件一条行为
  scripts/build.ts  四个平台的单文件,bun 交叉编译
  install.sh        curl | sh 那一行下载的就是它
  service-check/    交给 systemd 这件事的测试,连同它需要的那台机器
  agent-check/      注册表里每个 agent 跑同一套旅程,跑真的二进制
  generated/        生成物,永不手改
packages/universal/ 两边必须算出同一个答案的东西
rules/              这个仓库对自己的要求,写成测试。清单见 rules/README.md
e2e/                真浏览器走一遍整条旅程。跑的是构建产物 + 真 server + 真库,
                    一个 origin,和线上同一个形状。唯一的替身是 agent 进程 —— 见 a-machine.ts
docs/               稳定规则 + roadmap 下每条旅程的 prd/design
.21st/              视觉简报,给设计工具读的。**是输入,不是产物** —— 界面照它做,
                    它不照界面生成。和 prd 重叠的部分以 prd 为准:prd 说做什么,
                    这里说长什么样
compose.yml         一个 postgres 两个库,和一个放脸的对象存储
```

**边界由工具强制,不靠自觉。** 按包名跨过去,pnpm 找不到;用 `../` 绕过去,
`rootDir` 让它编译不过。

`apps/server/src/env.ts` 和 `apps/cli/src/env.ts` 是**唯二**读 `process.env` 的文件,
`src/log.ts` 是唯一写 stdout 的,两条都由 `lint` 强制。别处拿到的是已经 parse 过的值。

`packages/universal` 的入包标准就是它的名字:**能在两边跑的才进来**。
只有一边算得了的东西走网线 —— 响应里的值对发出它的那个部署永远是对的,
编译进页面的值只在没人改另一边之前是对的。

**具体有哪些 owner 和 adapter 见对应旅程的 `design.md`。** 本文件只规定形态。

上面这些是**现在真有的**。还没开始的那一片会带来的目录,写在它自己的 `design.md` 里,
不预先列在这里 —— 一个找不到的目录和一个不该存在的目录一样费解。

新增一个根目录条目需要和新增一个 owner 同等的理由。

## 2. 生成物与手写物物理分开

```
generated/schema.sql   pg_dump 出的当前 schema,评审时能直接读
generated/db.ts        kysely-codegen 出的类型
generated/openapi.json 从路由导出的契约
generated/api.ts       web 和 cli 各一份,从上面那个 json 生成
其余                   手写
```

**契约共享,客户端不共享。** 两个应用从同一份 `openapi.json` 各生成一份类型,但浏览器那个靠
cookie、命令行那个靠 bearer token —— 抽成一个客户端只会逼出一个两边都别扭的最小公倍数。

两份都由 `pnpm generate` 产生,**逐字节可复现**:pg_dump 的 `\restrict` key 定死,
postgres 镜像钉到补丁版本。否则 `git diff --exit-code generated` 会红在无关的原因上。

- 手写任何一份生成物的镜像 = B12,生成结果与完整 diff 的人工评审拦。
- 生成物进版本库(评审时可见漂移),但改动只能来自重新生成。
- `pnpm check` 里跑一次 `generate` 并断言无 diff。

## 3. 文档只保留一个当前答案

```
roadmap/<旅程>/prd.md       这一片用户能做什么、系统承诺什么、失败时会发生什么
roadmap/<旅程>/design.md    这一片的技术方案:owner、身份、事务、协议、schema
architecture.md             不随功能变化的部分:拓扑、依赖方向、权威、三态
code-style.md               手写代码的可执行美学规则
repository.md               本文件
AGENTS.md                   交付流程
```

**一个事实只有一个家。** 研究过程、评审记录、备选方案不进仓库——它们属于对应的 Issue 和 PR。

文档不复制源码类型作为第二份真相;必要的代码块只做示例,完整 diff 时人工检查漂移。

## 4. 命令

```
pnpm db:up        起 postgres,等到 healthy
pnpm db:down      连数据卷一起删
pnpm migrate      把开发库迁到最新
pnpm test:db      把测试库迁到最新

pnpm dev          API
pnpm web          浏览器应用
pnpm build        打包浏览器应用;Vite 8 的 Baseline Widely Available 目标,275 kB raw chunk 起警告

pnpm --filter @handover/server release   一次发布对数据库做的事:把迁移应用上去,别的什么都不做
pnpm --filter @handover/cli build   四个平台的可执行文件,进 apps/cli/dist

pnpm generate     迁移测试库 → schema.sql → db.ts → openapi.json → 浏览器的类型 → 路由树
pnpm typecheck    三个包各自的类型世界
pnpm lint         oxlint,type-aware,按包
pnpm format       prettier --check
pnpm unused       knip:没人 import 的文件、export、依赖
pnpm duplication  jscpd:跨文件的复制粘贴。测试不算 —— 布置同一个场景本来就该长得像
pnpm test         vitest —— 四组:unit · web · db(要 postgres)· service(要 docker 里的 systemd)
pnpm test:agents  第五组,单独点名跑:真的 claude 和 codex,花真的模型调用
pnpm coverage     跑一遍并打一张表。不设阈值:百分比不是关于正确性的事实
pnpm check        以上全部 + generate 无 diff
```

**克隆之后只需要 Docker。** `pg_dump` 从容器里跑,不要求本机装 postgres 客户端,
也就不会出现本机版本和服务端版本对不上的那类失败。

**本地和 CI 调用同一条命令。** 同一条检查不重复编码在 YAML、脚本和 package.json 里。

**一个服务器,两个库。** 进程连哪个由 `DATABASE_URL` 决定,所以指着开发库的东西碰不到测试库。
测试库不用手动建,`dbmate up` 发现它不存在就会建。

`.env` 不进版本库,`.env.example` 进;`.env.test` 也进 —— 它只指向 `compose.yml` 里那个
测试库,没有秘密,少一步本地配置。真实环境变量优先于文件,所以 CI 和生产注入同名变量即可。

## 4.1 部署这台服务器需要什么

**还没有部署过任何地方。** 下面是镜像里已经做完的部分,以及必须由外面提供的部分 —— 分开写,
是因为前者验过,后者没有。

```
镜像做完的     装依赖 · 打包网页 · 起进程 · WEB_ROOT 指向打包出来的页面
一次发布做的   pnpm --filter @handover/server release —— 只把迁移应用上去
```

**迁移是发布的一步,不是启动的一步。** 两个实例同时启动就会同时迁移,而失败一半的部署没有人
能说清楚它停在哪。所以:先跑 release,再让新实例起来。

**网页和 API 同源,这是被逼的不是选的。** 页面的调用不带自己的 origin,会话 cookie 是
`SameSite=Lax` —— 页面放在另一个 origin 上,每一次调用都会以未登录的身份到达。要用 CDN 或
反向代理伺候页面就把 `WEB_ROOT` 留空,那时这个进程只是 API。**不允许的是两个 origin。**

必须由外面给的,一个都不能少:

```
DATABASE_URL          托管的 postgres
AUTH_SECRET           32 位以上随机
PUBLIC_ORIGIN         浏览器怎么找到这台服务器;OAuth 回调地址由它拼出来
RESEND_API_KEY        没有它且 NODE_ENV≠development 时进程拒绝启动
MAIL_FROM             发信域名要先在 Resend 那边过 DNS 验证
TRUSTED_PROXY_HOPS    真实代理层数。这是唯一一个填错了不报错、只是静默失效的:
                      填 0 而前面有代理,发信限流就能被 X-Forwarded-For 绕过
GOOGLE / GITHUB 的     可选,但要成对;回调地址填 <PUBLIC_ORIGIN>/auth/<provider>/callback
CLIENT_ID / SECRET
```

**健康检查用 `GET /auth/credentials`** —— 它公开、便宜、不碰数据库。不为此单开一个 `/health`:
一个只有平台在读的路由,是一个没有人负责的用户可见名词。

---

## 5. 检查边界

自动化检查三类东西:

```
通用机械事实      类型 · lint · 格式 · 生成漂移 · 行为结果
没人用的东西      knip:文件、export、依赖
结构不变量        rules/ 下每条一个文件,扫全库的源文件
```

**能机械检查的不变量,写成一条规则,不要写成注释。** 注释会和代码分家,分家之后它变成谎话。

**规则守结构,行为测试守承诺。** 一条规则说的是"每一处读 memberships 都必须带 `revoked_at`";
"被移除的人看不到别人的机器"是一条行为测试。前者防的是下一次有人漏写,后者防的是这一次写错。

这一节从前写的是反的("不写自研检查,依赖方向和命名由人工评审判断")。改掉是因为数出来的账:
**机械化的那几条,违反数是 0;没机械化的那一条,积了 365 处。**

责任边界和命名仍然是人工评审的事 —— 那两样目前还没有一条写得出来的机械判据。

## 6. 删除

每个节点结束时同时检查:被替代的模块 · 旧路由 · 无调用的 script · 生成输出 · 依赖 · CI job。

删除条件不是"以后永远不会用",而是**"当前没有消费者、没有合同、没有仍然有效的证据"**。

被替代的路径不能活过它的节点。关闭时读完整 diff,确认节点声明删除的符号真的不存在。

## 7. CI

```
main       全量 pnpm check
PR         同上
release    tag v* → 四个平台的可执行文件 + SHA256SUMS → GitHub Release
```

**还没有 nightly。** 真实凭据的 canary(Resend、两个 OAuth)要等这套东西真的部署在某处 ——
现在写一个,它只会因为没有 secret 而绿,那比没有更糟。

**release 是一个 job,不是每个平台一个。** bun 交叉编译,所以一次发布里的四个文件出自同一份源码的
同一时刻;分成四个 job 就有了「一半是这版一半是上版」这种状态。

**tag 就是版本号**,由 `HANDOVER_VERSION` 写进二进制 —— 手里的文件能自己说出它来自哪个 commit。

浏览器失败时保留 trace 和截图。

## 7.1 浏览器基线

Vite 的 `baseline-widely-available` 是这版的浏览器合同:Chrome/Edge 111、Firefox 114、
Safari/iOS 16.4 起。不按印象写「现代浏览器」,也不默默给更老的浏览器发一份看似能跑的包;
真要扩大范围时改 `build.target`,并带上对应的真实设备证据。

`chunkSizeWarningLimit` 是 275 kB raw。它不是性能指标,只是让当前的路由切分在变差时出声 ——
体积本身不证明 Core Web Vitals,那要等真的部署在某处、有 field 数据可看。

## 8. 合并前

1. 新文件是否放在事实 owner 旁边,并以一个 owner 行为命名?
2. 是否创建了新的中央清单或垃圾桶目录?
3. 生成代码是否与手写代码分开?
4. 是否留下了被替代的代码、文档、命令或 job?
5. 机械规则是否由通用工具检查,产品承诺是否有行为测试?
6. **删掉这个新抽象之后,仓库是否反而更容易理解?**

第 6 条答"是"就不要合并这个抽象。
