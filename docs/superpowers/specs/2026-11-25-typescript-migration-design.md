# ReproLens TypeScript 迁移设计

**日期**：2026-11-25
**状态**：已确认，进入实施
**目标**：将 ReproLens Agent 的 Go 实现迁移为业内通用、可维护、可测试的 TypeScript/Node.js 实现，同时保持既有 CLI、HTTP API、状态机、证据链与部署适配能力。

## 1. 范围

迁移覆盖以下能力，不缩减产品功能：

- 论文与仓库摄取：Markdown/TXT/RST/DOCX/PDF 文本解析、仓库扫描、命令候选提取。
- 主张抽取：确定性启发式、OpenAI-compatible Chat Completions、主模型失败回退。
- 实验规划：生成单条受限 shell 命令、种子、镜像、指标抽取规则。
- 执行适配：Local、Docker、SSH、Colab 风格租赁平台。
- CodeAgent 委派：Mock、通用 CLI、Claude/Codex/Gemini 预设；在隔离副本中产出 diff。
- 补丁治理：路径穿越防护、备份、git apply 校验、人工审批、失败回滚。
- 规则核验：PASS / DIFFERENT / INSUFFICIENT_EVIDENCE / FAILED，模型和 CodeAgent 不得写最终判决。
- 证据与报告：事件日志、运行日志、Markdown 报告、ZIP 复现包。
- 交互面：CLI 与 Fastify HTTP API/静态控制台；未来网页端可直接复用同一组接口。

不包含：真实 Colab API 凭据接入、Web 前端重构、新论文算法实现、生产级多租户认证。

## 2. 技术决策

| 领域 | 选型 | 原因 |
|---|---|---|
| 运行时 | Node.js >= 22，CI 推荐 24 | 当前 LTS 生态、原生 ESM、跨平台 |
| 语言 | TypeScript 5，`strict: true` | 行业通用，接口边界可静态检查 |
| HTTP | Fastify 5 | 类型友好、插件化、低开销、测试注入方便 |
| 数据库 | better-sqlite3 | 与现有 SQLite schema 兼容，同步事务简单可靠 |
| 测试 | Vitest | TypeScript 原生支持，速度快，适合单元与集成测试 |
| CLI | Commander | 命令与选项定义清晰，便于扩展 |
| 校验 | Zod | 外部 HTTP/平台响应与配置的运行时边界校验 |
| ZIP/TAR | adm-zip + tar | DOCX 读取、证据包与工作区归档 |
| 日志 | pino（Fastify 内置） | 结构化日志，后续可接观测平台 |

## 3. 目录与模块职责

```text
src/
  cli.ts                      CLI 入口与命令编排
  config.ts                   环境变量、.env、配置校验
  domain/
    state.ts                  状态、动作、转移表
    types.ts                  领域类型与 JSON 契约
  store/
    store.ts                  Store 接口与错误
    memory-store.ts           测试/演示内存实现
    sqlite-store.ts           持久化工程状态与追加式事件
  agent/
    analyzer.ts               Analyzer 接口
    heuristic.ts              离线确定性抽取、规划、诊断
    openai.ts                 OpenAI-compatible 适配器
    fallback.ts               主分析器失败回退
  codeagent/
    code-agent.ts             CodeAgent 接口与任务/结果类型
    mock.ts                   测试替身
    command.ts                隔离副本、CLI 委派、git diff、验收命令
  tools/
    workspace.ts              工程工作区、证据目录、仓库复制
    paper.ts                  Markdown/DOCX/PDF 摄取
    repo.ts                   仓库扫描
    patch.ts                  补丁校验、备份、应用、回滚
    verify.ts                 指标抽取与规则判决
    report.ts                 Markdown 报告与 ZIP 导出
    archive.ts                tar.gz 工作区归档
    runner.ts                 Runner 接口、命令校验、证据落盘
    local-runner.ts
    docker-runner.ts
    ssh-runner.ts
    platform-runner.ts
  orchestrator/
    orchestrator.ts           创建、启动、选主张、确认计划、审批/拒绝、停止
    execute.ts                执行循环、重试、CodeAgent 委派、报告收尾
  platformmock/
    server.ts                 Colab 风格 HTTP mock
  demo.ts                     内置可复现样例物化
  httpapi/
    server.ts                 Fastify 路由、SSE、报告/证据包下载
    public/                   静态控制台资源
assets/demo/                  内置论文与仓库样例
tests/                        Vitest 单元/集成测试
```

模块只通过显式接口通信；Runner、Analyzer、CodeAgent、Store 均可在构造时注入，供未来网页端或 MCP 适配器切换。

## 4. 状态机

状态与转移保持原实现：

```text
CREATED
  --init--> INITIALIZED
  --ingest--> INGESTED
  --extract_claims--> AWAITING_CLAIMS
  --select_claims--> AWAITING_PLAN
  --confirm_plan--> SANDBOX_READY
  --start_execution--> EXECUTING
  --run_succeeded--> VERIFYING
  --run_failed--> AWAITING_PATCH
  --approve_patch--> RETRYING
  --retry_start--> EXECUTING
  --reject_patch--> FAILED
VERIFYING
  --next_plan--> EXECUTING
  --verification_completed--> REPORTING
REPORTING
  --report_completed--> COMPLETED
```

任意非终态可 `stop` 到 `STOPPED`，任意非终态可 `fail` 到 `FAILED`；终态不可再转移。状态转移必须先持久化再写事件，避免状态与证据链不一致。

## 5. 数据与持久化

- 项目表：`id`, `state`, `payload`(JSON), `updated_at`。
- 事件表：`id`, `project_id`, `seq`, `type`, `message`, `data_json`, `created_at`，`(project_id, seq)` 唯一。
- 每个项目的工作目录为 `data/projects/<id>/{workspace,evidence,artifacts}`。
- 事件采用追加写，序号连续；API 的 `after` 参数按 `seq` 过滤。
- 所有 JSON 字段继续使用 snake_case，以保持现有 API 与已生成证据包的兼容性。

## 6. 安全边界

- 执行命令必须是单行白名单可执行程序，禁止 `&&`、`||`、`;`、管道、重定向、命令替换和多语句。
- 工作目录必须位于工程 workspace 内。
- 补丁只允许普通文件修改与新增；禁止删除、重命名、二进制补丁、`.git`/`.reprolens` 内部路径和路径穿越。
- CodeAgent 只在复制出的临时 workspace 中工作，返回 diff；不直接写入原 workspace。
- 最终 verdict 只由 `verify.ts` 的数值规则计算，模型输出不能覆盖。
- `.env` 和 `data/` 不进入版本控制；本地 API key 仅用于本地验证。

## 7. 错误处理与重试

- 执行失败进入 `AWAITING_PATCH`，由诊断器给出失败分类。
- 若诊断要求 CodeAgent 且未提供 diff，则调用注入的 CodeAgent；返回空 diff、超时、验收失败均视为项目失败。
- 补丁预算和运行预算由 `Budget` 控制，默认 `max_runs=3`, `max_seconds=120`, `max_patches=2`。
- 用户停止通过 AbortController 取消正在运行的 job；已产生证据保留。
- OpenAI-compatible 接口 400/422 时去掉 `response_format` 重试一次；其他错误回退启发式分析器。

## 8. 测试策略

- 单元：状态转移、启发式抽取、指标核验、补丁安全、命令校验、Docker/SSH 参数。
- 集成：Memory/SQLite 事件序列；Fastify `/healthz`、demo 创建/启动/事件；本地 demo 到 PASS；Colab mock 失败→补丁审批→重试→PASS。
- 真实适配：LLM `/chat/completions` mock；SSH 参数与可选 WSL 集成；CodeAgent CLI diff。
- 质量门：`npm run typecheck`、`npm test`、`npm run build`、`npm run demo -- --auto-approve`、`npm run colab-demo`。

## 9. 迁移验收清单

- [x] 仓库不再包含 Go 实现入口与 `go.mod`。
- [x] `npm install` 成功，`npm run build` 产出 `dist/cli.js`。
- [x] 所有原有 CLI 命令可用。
- [x] HTTP API 路径与响应字段保持兼容。
- [x] 本地 demo 在 CUDA 可用时可通过 GPU 开关运行。
- [x] Colab mock 端到端完成。
- [x] README、架构文档、扩展点文档、API 文档改为 TypeScript 示例。
- [x] 架构图更新为 TypeScript 技术栈，不改变状态机语义。

## 10. Web 控制台与运行时设置

在 TypeScript 迁移完成后新增可操控前端，仍使用 Fastify 静态资源，不引入独立 Web 工程：

- Codex 风格深色工作台：侧边导航、命令面板（Ctrl/Cmd+K）、状态条、事件流。
- 新建复现：PDF 上传、仓库 ZIP 上传、论文/仓库/数据路径、预算、runner、GPU、CodeAgent、SSH 与租赁平台参数。
- 运行时设置：OpenAI-compatible Base URL、API Key、模型名、超时、多模态开关；保存后立即替换 Analyzer/Runner/CodeAgent，并写入 `data/settings.json`。
- 项目详情：claims、plans、runs、patch diff、人工审批、规则 verdict、报告、证据包下载。
- 设置 API：`GET/PUT /api/v1/settings`、`POST /api/v1/settings/test-llm`。
- 上传 API：`POST /api/v1/uploads/paper`（PDF）、`POST /api/v1/uploads/repo`（ZIP）。
- PDF 视觉摄取采用 `pdfjs-dist` + `@napi-rs/canvas`，保留页面 PNG、caption 候选和可选多模态分析。

前端验收证据：

- `docs/ui-overview.png`
- `docs/ui-new-run.png`
- `docs/ui-settings.png`
- `docs/ui-project-pass.png`
- 浏览器端完整流程：新建项目 → 摄取 → 选 claim → 生成计划 → 失败 → 审批补丁 → 重跑 → PASS。
