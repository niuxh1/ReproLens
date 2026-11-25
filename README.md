# ReproLens（复现镜）

ReproLens 是一个用 **TypeScript / Node.js** 实现的“主张驱动”论文实验复现 Agent。它不把“代码能跑”当成“论文复现成功”，而是把论文主张、实验计划、受控执行、失败诊断、代码实现委派、人工审批、规则核验和证据包串成一条可审计闭环。

![ReproLens overview](docs/observatory-overview-final.png)

## 核心闭环

```text
原始 PDF + 代码仓库 + 数据
        ↓
INIT / INGEST / CLAIMS
        ↓
PLAN（主张 → 数据 → 脚本 → 参数 → 指标）
        ↓
SANDBOX / EXECUTE
        ↓
失败 → DIAGNOSE → CodeAgent 实现/修复 → 人工审批 → RETRY
        ↓
VERIFY（TypeScript 规则计算，模型不能写 verdict）
        ↓
REPORT + ZIP 复现包
```

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Node.js 22+，推荐 Node.js 24 |
| 语言 | TypeScript 5，`strict` 模式 |
| HTTP / UI | Fastify + 原生 HTML/CSS/ESM 控制台 |
| 持久化 | better-sqlite3（项目聚合 + 追加式事件日志） |
| 模型 | OpenAI-compatible Chat Completions；支持多模态页面图像 |
| PDF | `pdfjs-dist` 文本抽取 + `@napi-rs/canvas` 页面渲染 |
| 归档 | tar.gz 工作区归档 + adm-zip 证据包 |
| 测试 | Vitest |

## 不可破坏的约束

- `PASS / DIFFERENT / INSUFFICIENT_EVIDENCE / FAILED` 只由 `src/tools/verify.ts` 的数值规则计算。
- CodeAgent 只能在隔离副本中工作，返回统一 diff；不能直接改原始工作区。
- 补丁必须经过路径校验、证据记录和人工审批才能应用。
- 论文期望值、数据划分、指标定义和容差不能被代码 Agent 修改。
- Local runner 只用于演示/测试；真实隔离执行优先使用 Docker、SSH 或租赁平台。
- 每次运行保存命令、退出码、耗时、stdout/stderr、环境、GPU、provider、job id 和日志路径。
- PDF 不粗暴转文字：页面会渲染为 PNG，保留图表、表格和版式视觉证据；支持把页面图像发送给多模态模型。

## 可切换能力

| 能力 | TypeScript 接口 | 已实现 |
|---|---|---|
| 论文理解 | `src/agent/analyzer.ts` → `Analyzer` | Heuristic、OpenAI-compatible、Fallback |
| 执行器 | `src/tools/runner.ts` → `Runner` | local、Docker、SSH、Colab 风格租赁平台 |
| 代码实现器 | `src/codeagent/code-agent.ts` → `CodeAgent` | Mock、通用 CLI、Codex/Claude/Gemini 预设 |
| 状态存储 | `src/store/store.ts` → `Store` | Memory、SQLite |
| 编排 | `src/orchestrator/orchestrator.ts` | 确定性状态机、预算、审批、停止 |
| 交互 | `src/httpapi/server.ts` + `src/cli.ts` | Web 控制台、HTTP API、CLI |

未来网页端、MCP 或其它执行平台只需要实现这些接口，不需要改状态机和核验逻辑。

## 快速开始

```powershell
npm install
npm run typecheck
npm test
npm run build
```

启动 Web 控制台：

```powershell
npm run serve
# http://127.0.0.1:8080
```

控制台包含：总览与项目列表；新建复现（PDF / 仓库 ZIP 上传、预算、runner、GPU、CodeAgent）；运行时设置（模型 Base URL、API Key、模型名、多模态开关、超时）；SSH / Colab 风格平台参数；项目详情（状态机、claims、plans、runs、补丁审批、规则 verdict、报告与证据包下载）；`Ctrl/Cmd + K` 命令面板；SSE 实时事件流。

## CLI

```powershell
# 本地端到端 demo：失败 → 补丁 → 审批 → 重跑 → PASS
npm run demo -- --auto-approve

# Colab 风格平台 demo：选 T4 → 上传 → 提交 → 轮询 → 失败 → 补丁 → 重跑
npm run colab-demo

# 检查本地 OpenAI-compatible 接口
npm run check-llm

# 启动 Fastify 控制台
npm run serve

# 启动独立 Colab mock
npm run mock-colab -- --addr 127.0.0.1:8789

# SSH 部署探针
npm run ssh-demo -- --host asus@127.0.0.1 --port 2222 --identity .work\ssh\reprolens_wsl_rsa --base-dir /home/asus/reprolens-test --gpu
```

## 模型接入配置

`.env.example` 提供完整模板。最小模型配置：

```env
REPROLENS_LLM_BASE_URL=http://127.0.0.1:8788/v1
REPROLENS_LLM_API_KEY=replace-me
REPROLENS_LLM_MODEL=deepseek-v4.1-flash
REPROLENS_LLM_TIMEOUT=60s
REPROLENS_LLM_VISION=true
```

也可以直接在 Web 控制台的 **运行时设置 → OpenAI-compatible 接入** 中填写并保存。保存后：

1. 立即替换当前 Orchestrator 的 Analyzer、Runner、CodeAgent；
2. 写入 `data/settings.json`；
3. API Key 在读取时只返回掩码，留空保存会保留原 key；
4. 可用“测试连接”调用 `/api/v1/settings/test-llm`。

> 本地模型服务仅用于通路和功能测试；`data/settings.json`、`.env` 和 `data/` 不会进入版本控制。

## PDF 视觉摄取

`src/tools/paper.ts` 使用现成的 `pdfjs-dist` + `@napi-rs/canvas`：

1. 从 PDF 提取逐页文本；
2. 按页渲染 PNG（默认 1.5x，最多 1800px 宽）；
3. 保留 `Figure / Fig. / Table / 图 / 表` 等 caption 候选；
4. 生成 `PaperPage[]` 与 `PaperVisual[]`；
5. 若 `REPROLENS_LLM_VISION=true`，Analyzer 会把页面图像作为 `image_url` 发送给多模态模型；
6. 模型不支持图像或请求失败时，自动回退到文本提示，但页面图像仍保留在证据包中。

每个项目的证据目录包含：

```text
data/projects/<project-id>/evidence/paper/page-001.png
data/projects/<project-id>/evidence/paper/page-002.png
```

报告 ZIP 会同时包含原始 PDF、页面 PNG、运行日志、事件、项目快照、补丁和 Markdown 报告。

## 执行器

### Local

- 单行命令白名单；
- 工作目录必须位于 workspace 内；
- 可选 CUDA 环境变量；
- 仅建议在回环地址演示使用。

### Docker

- `--network none`；
- `--read-only`；
- 内存、CPU、PID 限制；
- `--cap-drop ALL` 与 `no-new-privileges`；
- GPU 开启时追加 `--gpus all`。

### SSH

- `scp -O` 上传 tar.gz 和运行脚本；
- `ssh` 远程解压并执行；
- 支持 WSL / dropbear 验证；
- 记录 remote job id、GPU 与 stdout/stderr。

### Colab 风格租赁平台

`PlatformRunner` 实现：

1. 读取 `/v1/offers`；
2. 按 GPU、VRAM、价格和 provider 自动选择最便宜的可用 offer；
3. 上传工作区；
4. 提交 job；
5. 轮询状态；
6. 拉取日志；
7. 将 provider、offer id、job id、GPU 写入证据。

本地 mock 在 `src/platformmock/server.ts`，真实平台只需实现 `docs/api.md` 中的 HTTP 合同。

## CodeAgent 委派

当诊断标记 `needs_code_agent` 且没有现成补丁时，Orchestrator 会：

1. 将工作区复制到 `evidence/codeagent/<run-id>/workspace-*`；
2. 初始化 git baseline；
3. 生成受约束的开发任务；
4. 调用配置的代码工具；
5. 可选执行验收命令；
6. 用 git 生成统一 diff；
7. 校验 diff 路径与新增文件；
8. 将补丁置为 `proposed`，等待人工审批。

CodeAgent 不会直接写原始工作区，也不会写最终 verdict。

## 真实案例

已使用 2024 年 Grokfast 官方仓库完成真实 CUDA 复现：

- 论文：Lee et al. (2024), *Grokfast: Accelerated Grokking by Amplifying Slow Gradients*，arXiv `2405.20233`。
- 官方代码：`ironjr/grokfast`，MIT。
- Claim：Grokfast EMA 配置在模块乘法 Transformer 任务上约 910 次迭代达到 95% 验证准确率，容差 ±300。
- 本机结果：RTX 4060 Laptop，`torch 2.11.0+cu128`，43 秒，900 次迭代达到 95%，规则判定 **PASS**。
- 证据：`examples/grokfast/report.md` 和 `examples/grokfast/evidence/grokfast-reproduction-package.zip`。

详细说明见 `docs/real-paper-test.md`。


## Observatory 界面

控制台采用面向科研工作流的设计：

- 工作台展示真实项目统计、当前研究与最近项目；
- 项目工作区提供六阶段复现轨道、实验主张、计划、补丁审批与规则核验；
- 论文页签直接渲染原始 PDF 页面缩略图，并支持大图查看；
- 运行与日志页签展示结构化运行记录，stdout/stderr 在只读弹窗中打开；
- 模型与算力分为模型接入、执行与代码 Agent、远程与算力平台三组；
- 支持浅色/深色主题、可折叠侧栏、`Ctrl/Cmd + K` 命令面板、键盘焦点与 reduced-motion；
- 1440 / 1024 / 390 / 320 宽度均通过无横向溢出检查。

界面证据：

- `docs/observatory-overview-final.png`
- `docs/observatory-new-run-filled.png`
- `docs/observatory-project-plan.png`
- `docs/observatory-project-patch.png`
- `docs/observatory-project-pass.png`
- `docs/observatory-paper-real.png`
- `docs/observatory-paper-preview.png`
- `docs/observatory-settings.png`
- `docs/observatory-settings-execution.png`
- `docs/observatory-settings-compute.png`
- `docs/observatory-mobile-390.png`
- `docs/observatory-mobile-320.png`
- `docs/observatory-1024.png`
- `docs/observatory-dark.png`
- `docs/observatory-project-error.png`
## 目录

```text
src/cli.ts                  CLI：serve / demo / colab-demo / ssh-demo / mock-colab / check-llm
src/config.ts               环境变量与配置校验
src/runtime.ts              Analyzer / Runner / CodeAgent 构造与运行时设置持久化
src/agent/                  启发式、OpenAI-compatible、回退分析器
src/codeagent/              CodeAgent 接口、Mock、CLI 适配器
src/domain/                 状态机与领域类型
src/orchestrator/           确定性编排、审批、停止、预算
src/store/                  Memory / SQLite 存储
src/tools/                  PDF、仓库、workspace、runner、patch、verify、report
src/platformmock/           Colab 风格租赁平台 mock
src/httpapi/                Fastify API 与静态控制台
public/                     Codex 风格控制台 HTML/CSS/JS
tests/                      Vitest 单元与集成测试
examples/                   真实案例与复现脚本
docs/                       架构、接口、真实案例说明
```

## 测试

```powershell
npm run typecheck
npm test
npm run build
```

测试覆盖状态机、SQLite、事件序号、claim 抽取/去重、PDF 页面视觉证据、补丁路径与新增文件、GPU 参数、SSH 参数、Colab 平台选卡/轮询、CodeAgent diff、规则核验、报告/ZIP、运行时设置和端到端 demo。

## 限制

- 首版主要面向轻量 Python 项目，不承诺任意学科或大规模 GPU 论文。
- CodeAgent 的真实效果取决于所接代码工具的权限、模型和网络环境。
- 租赁平台适配器使用可配置 HTTP 合同；不同商业平台需要各自的认证/上传适配器。
- 人工审批仍是强制门；自动审批只用于演示/测试。
