# ReproLens Go Implementation Plan

**Goal:** Implement the ReproLens claim-driven computational reproduction agent with a deterministic state machine, evidence store, configurable local LLM, safe execution adapters, rule-based verification, and an embedded dashboard.

**Architecture:** A single Go binary wires an HTTP API, SQLite aggregate store, deterministic orchestrator, analyzer adapters, execution adapters, and evidence/report tools. The bundled demo proves one claim end-to-end: failure diagnosis, human patch approval, retry, and a rule-computed PASS verdict.

**Tech stack:** Go 1.24, standard `net/http`, `database/sql` plus `modernc.org/sqlite`, embedded HTML/CSS/JS, Docker CLI adapter, OpenAI-compatible Chat Completions adapter.

**Spec:** `docs/superpowers/specs/2026-11-25-reprolens-design.md`

## Constraints

- Go module: `reprolens`.
- Only `internal/tools.VerifyMetric` writes the final verdict.
- A patch cannot be applied without an approval event.
- All execution/patch paths must resolve inside the project workspace.
- The local runner is explicitly labeled `local (unsafe)` and exists for demos/tests.
- The LLM key is read from environment or `.env`; never write it into a report.
- Final gate: `go test ./...`, `go vet ./...`, `go build ./...`, and a real demo run.

## Task 1: Config

Files: `go.mod`, `internal/config/config.go`, `internal/config/config_test.go`, `.gitignore`, `.env`, `.env.example`.

- Write tests for defaults, `.env` parsing, and required-key validation.
- Run the tests and verify failure.
- Implement `config.Config` and `config.Load`.
- Run the tests again.

## Task 2: Domain and state machine

Files: `internal/domain/types.go`, `internal/domain/state.go`, `internal/domain/state_test.go`.

- Test valid transitions and rejection of patch approval outside `AWAITING_PATCH`.
- Implement aggregate types and transition guards.
- Run the tests.

## Task 3: Evidence store

Files: `internal/store/store.go`, `internal/store/memory.go`, `internal/store/sqlite.go`, `internal/store/store_test.go`.

- Test aggregate round-trip and per-project event sequencing.
- Implement memory and SQLite stores.
- Run the tests.

## Task 4: Heuristic analyzer

Files: `internal/agent/agent.go`, `internal/agent/heuristic.go`, `internal/agent/heuristic_test.go`.

- Test claim extraction, plan generation, and seed-mismatch diagnosis.
- Implement deterministic analysis.
- Run the tests.

## Task 5: OpenAI-compatible analyzer

Files: `internal/agent/openai.go`, `internal/agent/openai_test.go`.

- Test request shape and JSON response parsing with `httptest`.
- Implement the adapter against `/chat/completions`.
- Run the tests.

## Task 6: Workspace, parsers, patch safety

Files: `internal/tools/workspace.go`, `internal/tools/paper.go`, `internal/tools/repo.go`, `internal/tools/patch.go`, `internal/tools/tools_test.go`.

- Test path containment, DOCX extraction, README command discovery, and patch application.
- Implement size-limited workspace copy, paper/repo parsing, and validated unified-diff application.
- Run the tests.

## Task 7: Runners and verifier

Files: `internal/tools/runner.go`, `internal/tools/local_runner.go`, `internal/tools/docker_runner.go`, `internal/tools/verify.go`, plus tests.

- Test local stdout/stderr capture, timeout handling, Docker argument construction, tolerance comparison, and insufficient evidence.
- Implement both runners and the rule-only verifier.
- Run the tests.

## Task 8: Report and package

Files: `internal/tools/report.go`, `internal/tools/report_test.go`.

- Test report contents and ZIP entries.
- Implement Markdown, manifest JSON, and ZIP export.
- Run the tests.

## Task 9: Orchestrator and demo

Files: `internal/orchestrator/orchestrator.go`, `internal/orchestrator/orchestrator_test.go`, `internal/demo/demo.go`, `internal/demo/assets/**`, `internal/demo/demo_test.go`.

- Test the full demo: start, select claim, plan, execution failure, patch proposal, approval, rerun, PASS.
- Implement the state-machine workflow and demo materializer.
- Run the tests.

## Task 10: HTTP API, dashboard, CLI, docs

Files: `internal/httpapi/server.go`, `internal/httpapi/server_test.go`, `internal/httpapi/static/**`, `cmd/reprolens/main.go`, `README.md`, `docs/api.md`.

- Test health, demo creation, start, events, and error responses.
- Implement the API, embedded dashboard, CLI commands, and documentation.
- Run the tests.

## Task 11: Verification

- Run `go test ./...`.
- Run `go vet ./...`.
- Run `go build ./...`.
- Run `go run ./cmd/reprolens demo`.
- Start the server and exercise the dashboard/API.
- Audit the implementation against the spec.
## Task 12: GPU, remote deployment, and CodeAgent extensions

- Add GPU flags to local/Docker runners.
- Add SSH runner with archive upload and remote run script.
- Add Colab-style PlatformRunner with automatic offer selection and polling.
- Add CodeAgent interface, mock, and configurable CLI adapter.
- Add patch support for new files.
- Wire CodeAgent into the failure path after diagnosis.
- Add config and CLI demos: `colab-demo`, `ssh-demo`, `mock-colab`.
- Add WSL SSH integration test (environment-gated).
- Add real Grokfast 2024 CUDA case and evidence package.