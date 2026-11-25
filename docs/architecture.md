# ReproLens Architecture

## 1. Design principle

ReproLens is a deterministic workflow with bounded intelligence. The state machine owns transitions, budgets, approvals, retries, and stop conditions. Models and code agents may propose content, plans, diagnoses, and diffs, but cannot set the final verdict or bypass a human gate.

## 2. Layers

```text
CLI / Fastify API / Web console
              |
       Orchestrator (state machine, budget, approval, stop)
       |          |             |              |
    Analyzer   CodeAgent      Runner          Store
       |          |             |              |
 PDF + repo     diff       local/docker     SQLite + event log
 ingestion                  ssh
       |
 Verifier (TypeScript rules) -> Report / ZIP
```

## 3. State machine

```text
CREATED
  -> INITIALIZED
  -> INGESTED
  -> AWAITING_CLAIMS
  -> AWAITING_PLAN
  -> SANDBOX_READY
  -> EXECUTING
      -> AWAITING_PATCH (failure with patch/implementation)
      -> VERIFYING (success)
      -> FAILED (unrecoverable)
  -> RETRYING (approved patch)
      -> EXECUTING
  -> VERIFYING
      -> EXECUTING (next selected plan)
      -> REPORTING (all plans verified)
  -> COMPLETED

Any non-terminal state -> STOPPED (user stop)
```

All transitions are defined in `src/domain/state.ts`. A state change is persisted before the next step, and every transition appends an event to the store.

## 4. Core interfaces

| Interface | Location | Contract |
|---|---|---|
| `Analyzer` | `src/agent/analyzer.ts` | Extract claims, build plans, diagnose failures |
| `Runner` | `src/tools/runner.ts` | Execute a command in local/Docker/SSH environment |
| `CodeAgent` | `src/codeagent/code-agent.ts` | Propose an implementation diff in a disposable copy |
| `Store` | `src/store/store.ts` | Persist project aggregate and append-only events |
| `Orchestrator` | `src/orchestrator/orchestrator.ts` | Own workflow transitions and approvals |

## 5. Evidence model

Each run records project/claim ids, command, runner, image, provider, offer id, remote job id, exit code, timestamps, duration, stdout/stderr paths, environment, and GPU flag.

Each patch records diagnosis/root cause, unified diff, changed files, approval identity/time, and CodeAgent name/version/log/summary when delegated.

PDF evidence records page text, rendered page PNG, dimensions, caption candidates, and optional model visual analysis. The ZIP package includes `manifest.json`, `project.json`, `events.json`, `report.md`, patch diff, run logs, original PDF, and page PNGs.

## 6. Security boundaries

- Execution commands are validated before local execution.
- Docker uses no-network by default, resource limits, dropped capabilities, no-new-privileges, and a workspace-only mount.
- SSH uploads a tar.gz to a remote directory and runs a generated script.
- CodeAgent works on a copy; it cannot directly modify the original workspace.
- PatchManager rejects path traversal, internal metadata changes, symlinks, deletions, renames, and binary diffs.
- New files are allowed only when the diff is a valid creation patch.

## 7. Model and code-tool boundary

The Analyzer is intentionally separated from the CodeAgent:

- Analyzer: scientific interpretation, PDF page understanding, and diagnosis.
- CodeAgent: code implementation/repair.
- PatchManager: safety validation and application.
- Verifier: deterministic metric comparison.

This prevents a code tool from making the test pass by changing the claim, metric, data split, or tolerance.

## 8. Deployment modes

- `local`: demo/test only, explicitly labeled unsafe.
- `docker`: isolated real execution.
- `ssh`: direct remote host via scp/ssh.
- `codex`/`claude`/`gemini`/`command`: CodeAgent implementations for code changes.

## 9. Failure handling

- A failed run is diagnosed by the Analyzer.
- If a safe patch is available, the workflow pauses at `AWAITING_PATCH`.
- If no patch is available and `needs_code_agent` is true, the orchestrator delegates implementation to the CodeAgent.
- The CodeAgent returns a diff; PatchManager validates it; the workflow pauses for approval.
- If the budget, retry limit, or patch limit is exhausted, the workflow fails with evidence.
- A user stop aborts the active job and records `STOPPED`.
