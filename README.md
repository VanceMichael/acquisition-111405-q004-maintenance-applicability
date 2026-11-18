# 维修手册的适用条件资料采集

这是资料接收服务的独立工作副本。当前版本既支持人工摘要的领取、原文归档、重复导入和归档检查，也支持按设备配置发布的新来源：采集章节、插图及适用判断的条件依据。

## 环境

Node.js 22，运行与测试只用标准库，无外部服务、数据库、浏览器或联网下载。依赖清单和 npm 锁文件均已提供。

```sh
npm test
npm run demo
```

`npm test` 是初始产品的基线回归，验证现有摘要通路、原文摘要检查、本地来源响应，以及 CLI 在独立进程中的真实领取、重复导入和持久归档检查。该产品是一次执行后退出的采集程序，不提供常驻 HTTP 应用；`npm run collect` 执行领取，`npm run provider` 仅单独启动测试来源。

`npm run acceptance:source` 执行 `test/feature.test.mjs` 中完整的新来源验收。`npm run test:boundary` 追加与设计一致的边界验证：空配置与缺键保持未知、三值逻辑短路、条件目录版本冲突、章节内容版本不一致、重复章节及归档身份稳定。交付时 `npm run verify:complete` 同时执行基线、新来源验收和边界验证，三者都需通过。

## 适用判断口径

- 章节条件只有确定为真才领取章节与插图；确定为假记为 `inapplicable` 且不访问资源；其余一律 `unknown`，在 `missingConditions` 中留下依据并保留来源位置。
- 设备配置的 `null`、缺键和缺失配置响应都保持未知，不写成不适用。`eq` 严格比较，不做隐式类型转换。
- 共用条件定义可互相引用；循环引用、缺定义和无法闭合的目录都记为缺口，不猜测结论。
- 条件目录 issue 与手册不一致时，其定义不能用于解释 `ref`；手册内联条件仍独立判定，已确认的部分保留。
- 章节内容 issue 与手册不一致时不并入作业包，记录 `contentVerified=false` 且不领取其插图。
- `complete` 仅在本次领取与解释没有未决缺口时为真；任何缺口都会使它为假并进入 `issues`。

```sh
npm run verify:complete
npm run demo:feature
```

正式演示使用 `npm run demo:feature`，从空临时归档启动本地来源、实际采集并打印结果后退出；无需重放旧日志。`SCENARIO` 可选择 `fixtures/scenarios.json` 中的情景，默认 `unknown-config`。单次命令应在90秒内结束，不使用真实客户数据。`SCENARIO=condition-issue-mismatch npm run demo:feature` 可见版本冲突时不生成可用章节、只保留缺口与原文证据。

## 容器

```sh
docker build -t acquisition-maintenance-applicability:local .
docker run --rm --network none acquisition-maintenance-applicability:local
docker run --rm --network none acquisition-maintenance-applicability:local npm run demo:feature
```

镜像固定 Node.js 版本及基础镜像摘要；首次构建可提前拉取基础镜像，正式运行不安装或下载。容器中来源与采集器同进程启动，不需要第二个容器。默认容器命令跑基线测试与实际摘要导入；按设备配置领取可用 `npm run demo:feature` 单独执行。

## 工作入口

- `src/collector.mjs` 的 `collect` 是业务入口；既有 `legacy` 模式保留，新来源为 `source` 模式。
- `src/source.mjs` 实现配置化领取与三值适用判断；条件解释与网络领取分开，便于单独复核。
- `src/transport.mjs` 提供原文字节与请求证据，错误状态由业务层判断。
- `src/archive.mjs` 支持内容寻址原文与记录修订，存储位置由调用方传入。
- `provider/server.mjs` 提供允许访问的本地合成来源，路径和例子见 `docs/source-contract.md`。
- `test/feature.test.mjs` 对输出使用局部结构断言，不限制内部模块划分。

`ARCHIVE_DIR` 指定持久目录，`SOURCE_URL` 可连接另行启动的本地来源；两者均未设置时演示自动清理临时目录。`node src/cli.mjs inspect` 配合 `ARCHIVE_DIR` 查看当前索引。不要用来源服务的 fixture 对象直接生成业务结果，真实接收需经 HTTP。
