# 维修手册的适用条件资料采集

这是资料接收服务的独立工作副本。当前版本支持两条领取通路：人工摘要的 `legacy` 模式（原文归档、重复导入和归档检查），以及按设备配置领取维修章节的 `source` 模式。

## 环境

Node.js 22，运行与测试只用标准库，无外部服务、数据库、浏览器或联网下载。依赖清单和 npm 锁文件均已提供。

```sh
npm test
npm run demo
```

`npm test` 是初始产品的基线回归，验证现有摘要通路、原文摘要检查、本地来源响应，以及 CLI 在独立进程中的真实领取、重复导入和持久归档检查。该产品是一次执行后退出的采集程序，不提供常驻 HTTP 应用；`npm run collect` 执行领取，`npm run provider` 仅单独启动测试来源。

`npm run acceptance:source` 执行 `test/feature.test.mjs` 中完整的新来源验收，覆盖配置未知、确定适用、条件定义循环和条件目录版本不一致四类情景；`npm run acceptance:edge` 执行 `test/source-edge.test.mjs` 的设计边界验证（三值逻辑、严格相等、挡裁独立性、资源失败、越界链接与幂等）。交付时执行 `npm run verify:complete`，让基线、新来源验收和边界验证同时通过；不能只用基线成功说明新功能已完成。

```sh
npm run verify:complete
npm run demo:feature
```

正式演示使用完成后的 `npm run demo:feature`，从空临时归档启动本地来源、实际采集并打印结果后退出；无需重放旧日志。`SCENARIO` 可选择 `fixtures/scenarios.json` 中的情景，默认 `unknown-config`。单次命令应在90秒内结束，不使用真实客户数据。

## 容器

```sh
docker build -t acquisition-maintenance-applicability:local .
docker run --rm --network none acquisition-maintenance-applicability:local
docker run --rm --network none acquisition-maintenance-applicability:local npm run demo:feature
```

镜像固定 Node.js 版本及基础镜像摘要；首次构建可提前拉取基础镜像，正式运行不安装或下载。容器中来源与采集器同进程启动，不需要第二个容器。默认容器命令跑现有测试与实际摘要导入，不将未开发功能伪装成成功。

## 工作入口

- `src/collector.mjs` 的 `collect` 是业务入口；`legacy` 模式保留原行为，`mode: 'source'` 进入配置化领取。
- `src/source.mjs` 实现 source 模式：领取手册索引、设备配置、条件目录与章节原文，按解释结果决定是否领取插图，并把可复核问题和原文证据提交归档。
- `src/conditions.mjs` 是适用条件解释器：三值结果（applicable/inapplicable/unknown），支持 `all`/`any`/`not`/`ref`/`eq`，严格相等不做隐式类型转换，处理 `ref` 互相引用（含循环）和缺失定义，设备属性为 `null` 或缺失时保留 unknown。
- `src/transport.mjs` 提供原文字节与请求证据，错误状态由业务层判断；相对链接只在来源 origin 内解析。
- `src/archive.mjs` 支持内容寻址原文与记录修订，存储位置由调用方传入；索引仍为 schema=1，旧摘要记录与新章节记录可同时读取。
- `provider/server.mjs` 提供允许访问的本地合成来源，路径和例子见 `docs/source-contract.md`。
- `test/feature.test.mjs` 与 `test/source-edge.test.mjs` 对输出使用局部结构断言，不限制内部模块划分。

### 不确定性与挡裁原则

- 设备选配未核实（配置键缺失或为 `null`）时，章节保留在 `unknown` 与 `missingConditions` 中，并记录 `CONFIGURATION_UNKNOWN` 依据，绝不改写成 `inapplicable`；unknown/inapplicable 章节不领取插图。
- 条件目录版本与章节版本不一致、目录不可用或定义成环时，引用共用定义的模块不生成作业包；不依赖目录的内联条件模块仍独立解释、独立入库，已收原文照常保留为证据。
- 章节响应 `issue` 与手册索引不一致的模块不入库；单张插图失败只标记该作业包不完整，不伪造成功，也不挡住其他模块。
- 空模块清单是有效空结果（`complete=true`），与错误缺口（有 `issues`、`complete=false`）区分。

`ARCHIVE_DIR` 指定持久目录，`SOURCE_URL` 可连接另行启动的本地来源；两者均未设置时演示自动清理临时目录。`node src/cli.mjs inspect` 配合 `ARCHIVE_DIR` 查看当前索引。不要用来源服务的 fixture 对象直接生成业务结果，真实接收需经 HTTP。
