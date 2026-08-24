# Handover 仓库

拥有:目录、生成物边界、命令、CI、删除纪律。

## 1. 根目录

```
src/
  <owner>/          一个事实 owner 一个目录,一个文件一条行为
  db/               持久化边界
  server/           入站传输
  host/             常驻,以及 host/<adapter>/ 具体运行时
  cli/              接入与保持在线
generated/          生成物,永不手改
migrations/         已提交的永不修改
queries/            SQL 是真相
scripts/            生成器与仓库维护脚本
docs/               稳定规则 + roadmap 下每条旅程的 prd/design
web/                浏览器应用
compose.yml         一个 postgres,两个库
```

`src/env.ts` 是**唯一**读 `process.env` 的文件,`lint` 强制。别处拿到的是已经 parse 过的 `Env`,
所以没有任何代码路径能看见一个没校验过的值。

**具体有哪些 owner 和 adapter 见对应旅程的 `design.md`。** 本文件只规定形态。

根目录只放上面这些。新增一个根目录条目需要和新增一个 owner 同等的理由。

## 2. 生成物与手写物物理分开

```
generated/schema.sql   pg_dump 出的当前 schema,评审时能直接读
generated/db.ts        kysely-codegen 出的类型
其余                   手写
```

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

pnpm generate     迁移测试库 → dump schema.sql → 生成 db.ts
pnpm typecheck
pnpm lint         oxlint,type-aware
pnpm format       prettier --check
pnpm test         vitest
pnpm test:db      只把测试库迁移到最新
pnpm check        以上全部 + generate 无 diff
```

**克隆之后只需要 Docker。** `pg_dump` 从容器里跑,不要求本机装 postgres 客户端,
也就不会出现本机版本和服务端版本对不上的那类失败。

**本地和 CI 调用同一条命令。** 同一条检查不重复编码在 YAML、脚本和 package.json 里。

**一个服务器,两个库。** 进程连哪个由 `DATABASE_URL` 决定,所以指着开发库的东西碰不到测试库。
测试库不用手动建,`dbmate up` 发现它不存在就会建。

`.env` 不进版本库,`.env.example` 进;`.env.test` 也进 —— 它只指向 `compose.yml` 里那个
测试库,没有秘密,少一步本地配置。真实环境变量优先于文件,所以 CI 和生产注入同名变量即可。

## 5. 检查边界

自动化只检查通用机械事实:类型、lint、格式、生成漂移和行为结果。

**不写扫描业务 owner、依赖方向、错误恢复或命名词表的自研检查。** 产品承诺进入行为测试;责任边界、依赖方向与命名在完整 diff 中人工评审。

## 6. 删除

每个节点结束时同时检查:被替代的模块 · 旧路由 · 无调用的 script · 生成输出 · 依赖 · CI job。

删除条件不是"以后永远不会用",而是**"当前没有消费者、没有合同、没有仍然有效的证据"**。

被替代的路径不能活过它的节点。关闭时读完整 diff,确认节点声明删除的符号真的不存在。

## 7. CI

```
main       全量 pnpm check
PR         同上
nightly    真实凭据的 canary(缺凭据时明确记录阻塞,不冒充通过)
release    构建产物 + checksum + 来源
```

浏览器失败时保留 trace 和截图。

## 8. 合并前

1. 新文件是否放在事实 owner 旁边,并以一个 owner 行为命名?
2. 是否创建了新的中央清单或垃圾桶目录?
3. 生成代码是否与手写代码分开?
4. 是否留下了被替代的代码、文档、命令或 job?
5. 机械规则是否由通用工具检查,产品承诺是否有行为测试?
6. **删掉这个新抽象之后,仓库是否反而更容易理解?**

第 6 条答"是"就不要合并这个抽象。
