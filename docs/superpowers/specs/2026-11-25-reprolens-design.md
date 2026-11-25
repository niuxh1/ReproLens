# ReproLens Design Spec

**Date:** 2026-11-25  
**Status:** Approved for implementation by the user's continue instruction  
**Goal:** Build a Go-based agent that reproduces a small computational claim, pauses for human approval when a patch is needed, verifies the result with rules, and exports an evidence-backed report and reproducible package.

## 1. Product Boundary

ReproLens is not a general research assistant. The first version implements one closed loop:

1. Import a public paper, a local code repository, and optional data.
2. Extract candidate claims with source locators.
3. Let the user select one or more claims.
4. Build a claim-to-experiment plan.
5. Let the user confirm the plan.
6. Prepare an isolated workspace and execute the plan.
7. Diagnose a failed run and propose a minimal patch.
8. Require explicit human approval before applying the patch.
9. Re-run, extract the observed metric, and compare it with the paper value using deterministic rules.
10. Export a Markdown/JSON report and a ZIP reproduction package.

The supported demo target is a lightweight Python 3.11 project. Arbitrary papers, GPU workloads, closed data, and automatic scientific judgment are out of scope.

## 2. Non-Negotiable Invariants

- A model may propose claims, plans, diagnoses, and patches, but may never write the final `verdict`.
- `PASS`, `DIFFERENT`, `INSUFFICIENT_EVIDENCE`, and `FAILED` are computed by Go rules.
- A patch is never applied without a recorded approval event.
- Every run records command, image/runner, exit code, duration, environment snapshot, stdout/stderr paths, and artifact hashes.
- The workflow is a deterministic state machine with explicit transitions; no free-form agent loop can skip approvals or budgets.
- Execution is restricted to a project workspace. Path traversal outside the workspace is rejected.
- The default real sandbox is Docker with no network, resource limits, and no-new-privileges. A local runner exists only for local demos/tests and is labeled as such.
- Stopping or exceeding the run budget produces `STOPPED` or `FAILED`, never a success report.

## 3. Architecture

### 3.1 Layers

| Layer | Go package | Responsibility |
|---|---|---|
| HTTP/UI | `internal/httpapi` | REST endpoints, embedded dashboard, event polling |
| Orchestration | `internal/orchestrator` | State machine, budgets, approvals, resume, stop |
| Intelligence | `internal/agent` | Claim extraction, plan generation, failure diagnosis |
| Tools | `internal/tools` | Paper/repo parsing, workspace, runners, patch, verification, report |
| Evidence | `internal/store` | SQLite aggregate state and append-only event log |

### 3.2 State Machine

```
CREATED
  -> INITIALIZED
  -> INGESTED
  -> AWAITING_CLAIMS
  -> AWAITING_PLAN
  -> SANDBOX_READY
  -> EXECUTING
       -> AWAITING_PATCH (failure with patch)
       -> VERIFYING (success)
       -> FAILED (failure without patch / budget exhausted)
  -> RETRYING (approved patch)
       -> EXECUTING
  -> VERIFYING
  -> REPORTING
  -> COMPLETED

Any non-terminal state -> STOPPED (user stop)
Any non-terminal state -> FAILED (unrecoverable error)
```

### 3.3 Aggregate Model

`Project` contains metadata, source paths, budget, parsed paper, repository summary, candidate claims, selected claim IDs, experiment plans, run attempts, current patch proposal, verification, report, and timestamps. The aggregate is stored as JSON in SQLite; events are a separate append-only table with monotonically increasing sequence numbers per project.

### 3.4 Intelligence Adapters

- `HeuristicAnalyzer`: deterministic parser for the demo and offline use.
- `OpenAICompatibleAnalyzer`: optional Chat Completions adapter using JSON output. It is enabled only when `REPROLENS_LLM_BASE_URL`, `REPROLENS_LLM_MODEL`, and an API key are configured.
- All analyzer output is validated before it reaches the state machine.

### 3.5 Execution Adapters

- `DockerRunner`: real isolation; `--network none`, `--memory`, `--cpus`, `--pids-limit`, `--cap-drop ALL`, `--security-opt no-new-privileges`, workspace-only mount, timeout.
- `LocalRunner`: explicit demo/test runner; uses a minimal allowlist and a scrubbed environment, but is not a security boundary.
- `Runner` interface allows fake runners in tests.

## 4. API Contract

- `POST /api/v1/projects` — create a project from local paths.
- `POST /api/v1/demo` — materialize and create the bundled demo project.
- `POST /api/v1/projects/{id}/start` — initialize, ingest, extract claims; stops at `AWAITING_CLAIMS`.
- `POST /api/v1/projects/{id}/claims` — select claims and build plans.
- `POST /api/v1/projects/{id}/plan/confirm` — async execute plan.
- `POST /api/v1/projects/{id}/patch/approve` — async apply approved patch and retry.
- `POST /api/v1/projects/{id}/patch/reject` — stop without applying patch.
- `POST /api/v1/projects/{id}/stop` — cancel current job.
- `GET /api/v1/projects/{id}` — aggregate state.
- `GET /api/v1/projects/{id}/events?after=N` — event log.
- `GET /api/v1/projects/{id}/report.md` — Markdown report.
- `GET /api/v1/projects/{id}/package` — ZIP package.
- `GET /healthz` — health check.
- `GET /` — embedded dashboard.

## 5. Demo Scenario

Bundled project `accuracy_demo`:

- Paper claims accuracy `0.81` with absolute tolerance `0.01`.
- Repository has `run_experiment.py` with a deliberately wrong seed `0` instead of the paper/plan seed `42`.
- First run exits with a seed-mismatch error and records evidence.
- Heuristic diagnosis proposes a one-line unified diff changing `SEED = 0` to `SEED = 42`.
- After approval, the rerun prints `accuracy=0.81`; the rule engine returns `PASS`.
- The report includes both attempts, the diff, the approval event, and the observed metric.

## 6. Testing Strategy

- Unit tests for state transitions, event sequencing, claim extraction, plan generation, diagnosis, metric extraction, tolerance comparison, and patch path safety.
- SQLite store tests using a temporary database.
- Workflow integration test with a fake analyzer/runner or the bundled demo + local runner.
- HTTP tests with `httptest`.
- Final verification: `go test ./...`, `go vet ./...`, `go build ./...`, and a real demo command.

## 7. Out of Scope

- MCP server integration in v1.
- Multi-user authentication, cloud storage, and remote job queues.
- Automatic installation of arbitrary dependencies.
- Automatic judgment of scientific validity beyond a declared metric and tolerance.
- Multi-claim parallel execution; plans run sequentially in v1.
## 8. CodeAgent Extension

ReproLens delegates complex implementation and repair tasks to a separate code tool rather than implementing paper algorithms inside the orchestrator.

- Interface: `internal/codeagent.Agent`.
- Implementations: deterministic Mock and configurable CLI adapter.
- CLI presets: Claude Code, Codex CLI, Gemini CLI, or a custom command.
- The CodeAgent works only in a disposable workspace copy.
- It returns a git-compatible diff, files, logs, and duration.
- PatchManager validates the diff and requires human approval.
- The code tool cannot change the expected value, metric, data split, tolerance, or verdict.

## 9. GPU and Deployment Channels

GPU is a runner capability recorded in run evidence.

- Local runner: sets `CUDA_VISIBLE_DEVICES` and `NVIDIA_VISIBLE_DEVICES`.
- Docker runner: adds `--gpus all` and GPU environment variables.
- SSH runner: deploys a tar.gz to a remote host and runs a generated script.
- Platform runner: selects a rental offer by GPU/VRAM/price, uploads an artifact, submits a job, polls status, and fetches logs.
- SSH was validated against a non-root dropbear server in WSL2.
- The Colab-style platform was validated with an in-process mock implementing the documented HTTP contract.

## 10. Real-Case Evidence

A 2024 Grokfast official-code case was reproduced on CUDA:

- Paper: arXiv 2405.20233.
- Claim: about 910 optimization iterations to 95% validation accuracy, tolerance ±300.
- Observed: 900 iterations.
- Verdict: PASS.
- Runtime: 43 seconds on an RTX 4060 Laptop.
- Evidence: `examples/grokfast/report.md` and the ZIP package under `examples/grokfast/evidence/`.
