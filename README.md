# ReproLens（复现镜）

ReproLens 是一个用 Go 实现的“主张驱动”论文实验复现 Agent。它不把“代码能跑”当成“论文复现成功”，而是把论文主张、实验计划、受控执行、失败诊断、代码实现委派、人工审批、规则核验和证据包串成一条可审计闭环。

## 核心闭环

```text
论文 + 代码仓库 + 公开数据
        ↓
INIT / INGEST / CLAIMS
        ↓
PLAN（主张 → 数据 → 脚本 → 参数 → 指标）
        ↓
SANDBOX / EXECUTE
        ↓
失败 → DIAGNOSE → CodeAgent 实现/修复 → 人工审批 → RETRY
        ↓
VERIFY（Go 规则计算，模型不能写 verdict）
        ↓
REPORT + ZIP 复现包
```

## 不可破坏的约束

- `PASS / DIFFERENT / INSUFFICIENT_EVIDENCE / FAILED` 只由 `internal/tools.VerifyMetric` 计算。
- CodeAgent 只能在隔离副本中工作，返回统一 diff；不能直接改原始工作区。
- 补丁必须经过路径校验、测试证据和人工审批才能应用。
- 论文期望值、数据划分、指标定义和容差不能被代码 Agent 修改。
- 本地 runner 仅用于演示/测试；真实隔离执行优先使用 Docker、SSH 或租赁平台。
- 每次运行保存命令、退出码、耗时、stdout/stderr、环境、GPU、provider、job id 和日志路径。

## 可切换能力

| 能力 | Go 接口 | 已实现 |
|---|---|---|
| 论文理解 | `internal/agent.Analyzer` | 启发式、OpenAI-compatible、失败回退 |
| 执行器 | `internal/tools.Runner` | local、Docker、SSH、Colab 风格租赁平台 |
| 代码实现器 | `internal/codeagent.Agent` | Mock、通用 CLI 适配器（Codex/Claude/Gemini） |
| 状态存储 | `internal/store.Store` | Memory、SQLite |
| 编排 | `internal/orchestrator.Orchestrator` | 确定性状态机、预算、审批、停止 |
| 交互 | `internal/httpapi.Server` | 可选 HTTP API 与嵌入式仪表盘 |

未来网页端只需要构造这些接口的实现，或通过配置选择实现，不需要改动状态机和核验逻辑。详见 `docs/extension-points.md`。

## 快速开始

要求 Go 1.26+（`go.mod` 会自动选择工具链）。

```powershell
go test ./...
go vet ./...
go build ./...
```

本地 demo：

```powershell
go run ./cmd/reprolens demo --auto-approve
```

Colab 风格租赁平台 demo（进程内 mock，自动选 T4、上传、提交、轮询、失败、补丁审批、重跑）：

```powershell
go run ./cmd/reprolens colab-demo
```

本地模型连通性：

```powershell
go run ./cmd/reprolens check-llm
```

可选的 HTTP 仪表盘：

```powershell
go run ./cmd/reprolens serve
# http://127.0.0.1:8080
```

## 配置

复制 `.env.example` 为 `.env`。主要配置：

```env
REPROLENS_LLM_BASE_URL=http://127.0.0.1:8788/v1
REPROLENS_LLM_API_KEY=...
REPROLENS_LLM_MODEL=deepseek-v4.1-flash
REPROLENS_ENABLE_GPU=true

# 选择执行器：auto | local | docker | ssh | colab | platform
REPROLENS_RUNNER=auto

# CodeAgent：none | claude | codex | gemini | command
REPROLENS_CODE_AGENT=none
REPROLENS_CODE_AGENT_CMD=
REPROLENS_CODE_AGENT_TIMEOUT=10m
REPROLENS_CODE_AGENT_RUN_ACCEPTANCE=false
```

Codex CLI 示例：

```powershell
$env:REPROLENS_CODE_AGENT='codex'
go run ./cmd/reprolens serve
```

默认 Codex 命令为：

```text
codex exec --approve-for-me --ephemeral
```

Claude Code 适配器默认命令为：

```text
claude -p --allowedTools Read,Edit,Write,Bash
```

本机 Claude Code 当前模型配置异常，因此实际委派验证使用 Codex CLI；通用命令适配器可切换任意代码工具。

## SSH 远程主机

真实 SSH 适配器支持 scp + ssh，在远程目录中解压工作区并运行命令。WSL2 上的 dropbear 已完成真实部署验证：

```powershell
go run ./cmd/reprolens ssh-demo `
  --host asus@127.0.0.1 `
  --port 2222 `
  --identity .work\ssh\reprolens_wsl_rsa `
  --base-dir /home/asus/reprolens-test `
  --gpu
```

验证输出包含 `SSH_DEPLOY_OK` 和 WSL 可见的 RTX 4060。实际服务器只需替换 Host、Port、Identity 和 BaseDir。

## Colab 风格租赁平台

`internal/tools.PlatformRunner` 实现了完整的租赁平台流程：

1. 读取平台 offers；
2. 按 GPU、VRAM、价格和 provider 自动选择最便宜的可用 offer；
3. 上传工作区 tar.gz；
4. 提交 Job；
5. 轮询状态；
6. 拉取 stdout/stderr；
7. 将 provider、offer id、job id、GPU 写入证据。

`internal/platformmock` 提供本地 mock 平台，用于验证选卡、上传、轮询和失败重试。真实平台只需实现文档中的 HTTP 合同并配置：

```env
REPROLENS_RUNNER=colab
REPROLENS_PLATFORM_BASE_URL=https://your-platform.example/v1
REPROLENS_PLATFORM_API_KEY=...
REPROLENS_PLATFORM_MIN_VRAM_GB=16
REPROLENS_PLATFORM_MAX_HOURLY_USD=0.5
```

## CodeAgent 委派

当诊断标记 `NeedsCodeAgent` 且没有现成补丁时，Orchestrator 会：

1. 将工作区复制到证据目录下的隔离副本；
2. 生成受约束的开发任务；
3. 调用配置的代码工具；
4. 运行可选验收命令；
5. 用 git 生成统一 diff；
6. 校验 diff 路径与新增文件；
7. 将补丁置为 `proposed`，等待人工审批。

CodeAgent 不会直接写原始工作区，也不会写最终 verdict。

## 真实案例

已使用 2024 年 Grokfast 官方仓库完成真实 CUDA 复现：

- 论文：Lee et al. (2024), *Grokfast: Accelerated Grokking by Amplifying Slow Gradients*，arXiv `2405.20233`。
- 官方代码：`ironjr/grokfast`，MIT。
- Claim：Grokfast EMA 配置在模块乘法 Transformer 任务上约 910 次迭代达到 95% 验证准确率，容差 ±300。
- 本机结果：RTX 4060 Laptop，`torch 2.11.0+cu128`，43 秒，900 次迭代达到 95%，规则判定 **PASS**。
- 证据：`examples/grokfast/report.md` 和 `examples/grokfast/evidence/grokfast-reproduction-package.zip`。

详细说明见 `docs/real-paper-test.md`。

## 目录

```text
cmd/reprolens/        CLI：serve / demo / colab-demo / ssh-demo / mock-colab / check-llm
internal/agent/       论文理解、诊断、模型回退
internal/codeagent/   CodeAgent 接口、Mock、通用 CLI 适配器
internal/domain/      聚合模型、状态机、证据结构
internal/orchestrator/确定性编排、审批、停止、预算
internal/store/       Memory / SQLite 存储
internal/tools/       论文/仓库解析、workspace、runner、patch、verify、report
internal/platformmock/ Colab 风格租赁平台 mock
internal/httpapi/     可选 HTTP API 与仪表盘
examples/             真实案例与复现脚本
docs/                 架构、接口、真实案例说明
```

## 测试

```powershell
go test ./...
go vet ./...
go build ./...
```

测试覆盖状态机、SQLite、事件序号、claim 抽取/去重、补丁路径与新增文件、GPU 参数、SSH 参数、Colab 平台选卡/轮询、CodeAgent diff、规则核验、报告/ZIP 和端到端 demo。

## 限制

- 首版主要面向轻量 Python 项目，不承诺任意学科或大规模 GPU 论文。
- CodeAgent 的真实效果取决于所接代码工具的权限、模型和网络环境。
- 租赁平台适配器使用可配置 HTTP 合同；不同商业平台需要各自的认证/上传适配器。
- 人工审批仍是强制门；自动审批只用于演示/测试。