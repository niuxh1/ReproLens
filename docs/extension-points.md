# ReproLens Extension Points

This document defines the switchable surfaces that a future web UI or API can expose. The core workflow does not need to be rewritten when a provider changes.

## 1. Analyzer

```go
type Analyzer interface {
    ExtractClaims(ctx, paper, repo) ([]domain.Claim, error)
    BuildPlan(ctx, claim, paper, repo) (*domain.ExperimentPlan, error)
    Diagnose(ctx, run, repo, workspace) (*domain.Diagnosis, error)
}
```

Implementations:

- `agent.Heuristic`: deterministic offline analyzer.
- `agent.OpenAICompatibleAnalyzer`: local or remote OpenAI-compatible endpoint.
- `agent.FallbackAnalyzer`: tries the primary analyzer and falls back to deterministic logic.

Switch with `REPROLENS_LLM_BASE_URL`, `REPROLENS_LLM_MODEL`, and `REPROLENS_LLM_API_KEY`.

## 2. Runner

```go
type Runner interface {
    Name() string
    Execute(ctx, ExecutionRequest) (ExecutionResult, error)
}
```

Implementations:

| Runner | Use |
|---|---|
| `LocalRunner` | Demo/test only; labeled unsafe |
| `DockerRunner` | Isolated local execution |
| `SSHRunner` | Remote host via scp/ssh |
| `PlatformRunner` | Colab-style rental platform |
| Fake runner | Unit/integration tests |

Switch with `REPROLENS_RUNNER=auto|local|docker|ssh|colab|platform`.

## 3. CodeAgent

```go
type Agent interface {
    Name() string
    Propose(ctx, Task) (*Result, error)
}
```

Implementations:

- `Mock`: deterministic tests.
- `CommandAgent`: wraps a professional coding CLI.

Supported command presets:

```env
REPROLENS_CODE_AGENT=codex
# default: codex exec --approve-for-me --ephemeral

REPROLENS_CODE_AGENT=claude
# default: claude -p --allowedTools Read,Edit,Write,Bash

REPROLENS_CODE_AGENT=command
REPROLENS_CODE_AGENT_CMD=my-coding-agent --non-interactive
```

The agent is invoked only when the diagnosis says `NeedsCodeAgent` and no safe patch exists. It receives a disposable workspace copy. Its diff is validated and held for human approval.

## 4. Store

```go
type Store interface {
    CreateProject(...)
    GetProject(...)
    SaveProject(...)
    AppendEvent(...)
    ListEvents(...)
}
```

Implementations:

- `store.Memory`: fast tests.
- `store.SQLite`: persistent project aggregate + append-only events.

## 5. GPU

GPU is a runner capability, recorded in run evidence:

- Local: sets `CUDA_VISIBLE_DEVICES=0` and `NVIDIA_VISIBLE_DEVICES=all`.
- Docker: adds `--gpus all` and GPU environment variables.
- SSH: exports GPU variables in the remote run script.
- Slurm/platform: records the selected GPU offer and provider.

Switch with `REPROLENS_ENABLE_GPU=true`.

## 6. Human approval

Approval is a separate action, not a provider switch:

```go
project, err := orchestrator.ApprovePatch(ctx, projectID, approvedBy)
```

No CodeAgent, model, runner, or platform can skip this gate. `RejectPatch` records the reason and terminates the workflow.

## 7. Future web integration

A future web backend can:

1. Build `Config` from its own form.
2. Choose an `Analyzer`, `Runner`, and `CodeAgent` implementation.
3. Construct `orchestrator.New(store, analyzer, runner, dataDir)`.
4. Call `SetCodeAgent` when CodeAgent is enabled.
5. Expose the orchestrator methods as API endpoints.
6. Read `Project`, `Event`, `Verification`, and `Report` values.

The current HTTP server is an optional reference implementation and is not required by the core agent.

## 8. Safe defaults

- `REPROLENS_CODE_AGENT=none`
- `REPROLENS_RUNNER=auto` (Docker if available, otherwise local loopback demo)
- `REPROLENS_ENABLE_GPU=false`
- Human approval required for every patch.