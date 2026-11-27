# ReproLens HTTP API Contract

The Fastify API and Observatory console are optional front ends. The core agent is usable from TypeScript or the CLI.

## 1. Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/livez` | Process liveness |
| `GET` | `/readyz` | Database and data-directory readiness |
| `GET` | `/healthz` | Backward-compatible aggregate health |
| `GET` | `/api/v1/options` | Runners, CodeAgents, states, model presets |
| `GET` | `/api/v1/settings` | Masked runtime settings |
| `PUT` | `/api/v1/settings` | Persist and apply model/runner/CodeAgent settings |
| `POST` | `/api/v1/settings/test-llm` | Probe the configured OpenAI-compatible endpoint |
| `POST` | `/api/v1/settings/test-code-agent` | Locate the configured CodeAgent executable and read its version |
| `POST` | `/api/v1/uploads/paper` | Upload a PDF and return a server-side path |
| `POST` | `/api/v1/uploads/repo` | Upload a repository ZIP and return an extracted directory |
| `GET` | `/api/v1/projects` | List projects |
| `POST` | `/api/v1/projects` | Create a project from paper/repo paths |
| `POST` | `/api/v1/demo` | Materialize and create the bundled demo |
| `GET` | `/api/v1/projects/{id}` | Read project aggregate |
| `POST` | `/api/v1/projects/{id}/start` | Init, ingest, render PDF pages, extract claims |
| `POST` | `/api/v1/projects/{id}/claims` | Select claims and build plans |
| `PATCH` | `/api/v1/projects/{id}/claims/{claimId}` | Correct a claim before plan generation |
| `POST` | `/api/v1/projects/{id}/plan/confirm` | Preflight and start async execution |
| `POST` | `/api/v1/projects/{id}/patch/approve` | Preflight and approve patch retry |
| `POST` | `/api/v1/projects/{id}/patch/reject` | Reject patch and stop |
| `POST` | `/api/v1/projects/{id}/stop` | Stop active job |
| `GET` | `/api/v1/projects/{id}/events` | Read events after a sequence |
| `GET` | `/api/v1/projects/{id}/events/stream` | SSE event stream |
| GET | /api/v1/projects/{id}/operations | Durable operation history, lease owner, status, and idempotency key |
| `GET` | `/api/v1/projects/{id}/report.md` | Download Markdown report |
| `GET` | `/api/v1/projects/{id}/report.html` | Render the readable/printable Chinese report |
| `POST` | `/api/v1/projects/{id}/report/summarize` | Regenerate the main-agent summary and report package |
| `GET` | `/api/v1/projects/{id}/package` | Download ZIP evidence package |

All responses include `x-request-id` and `x-reprolens-version`.

### Idempotency and optimistic concurrency

Mutating project operations accept:

```text
Idempotency-Key: <stable client-generated key>
If-Match: "rev-N"
```

- The same key with the same normalized request returns the existing operation result or a `202` for an operation still running.
- Reusing a key with a different request returns `409 IDEMPOTENCY_CONFLICT`.
- `GET /api/v1/projects/{id}` returns `ETag: "rev-N"` and `x-reprolens-revision`.
- A stale `If-Match` returns `409 REVISION_CONFLICT`.
- Accepted background operations return `operation_id`; poll `GET /api/v1/projects/{id}/operations` for durable status.

### Event pagination

`GET /api/v1/projects/{id}/events?after=<seq>&limit=<n>` returns a bounded page and:

```text
x-event-limit: 2000
x-next-cursor: 42
x-has-more: true
```

`after` and `limit` must be non-negative integers. The report generator uses an internal full-event reader, so long-running projects are not truncated at the API page limit.

## 2. Error contract

```json
{
  "error": {
    "code": "STATE_CONFLICT",
    "message": "plan confirmation requires AWAITING_PLAN state, got AWAITING_CLAIMS"
  }
}
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `INVALID_REQUEST` | Malformed JSON or schema failure |
| 404 | `NOT_FOUND` | Project, report, evidence, or package missing |
| 409 | `STATE_CONFLICT` | Wrong workflow state or project already busy |
| 409 | `PROJECT_BUSY` | Another exclusive operation is running for the project |
| 409 | `REVISION_CONFLICT` | `If-Match` revision is stale or the project changed concurrently |
| 409 | `IDEMPOTENCY_CONFLICT` | An idempotency key was reused with a different request |
| 409 | `ALREADY_EXISTS` | Duplicate project or resource |
| 422 | `VALIDATION_ERROR` | Semantically invalid operation |
| 500 | `INTERNAL_ERROR` | Unexpected server error |
| 503 | `NOT_READY` | Database or data directory unavailable |

Invalid state actions never mutate the project. They return `409` before any background job starts.

## 3. Create project

```json
{
  "name": "Grokfast reproduction",
  "paper_path": "C:\\research\\paper.pdf",
  "repo_path": "C:\\research\\official-repo",
  "data_path": "C:\\research\\data",
  "budget": {"max_runs": 3, "max_seconds": 900, "max_patches": 2}
}
```

`data_path` may be a file or directory. During ingestion it is copied into the isolated workspace:

```text
inputs/data/
```

Local, Docker, and SSH execution therefore see the same dataset staging path. A `data_staged` event records the source, target, and kind.

## 4. Runtime settings

```json
{
  "runner": "docker",
  "enableGPU": true,
  "llm": {
    "baseURL": "http://127.0.0.1:8788/v1",
    "apiKey": "local-key",
    "model": "deepseek-v4.1-flash",
    "timeoutMs": 60000,
    "vision": true
  },
  "codeAgent": {"type": "codex", "command": "codex exec --approve-for-me --ephemeral"},
  "remote": {
    "host": "user@host",
    "port": 22,
    "identity": "/path/to/key",
    "baseDir": "/tmp/reprolens"
  }
}
```

Supported runners are `auto`, `local`, `docker`, and `ssh`. API keys are returned masked. Omit `apiKey` or send an empty value to keep the existing key. Non-loopback `REPROLENS_ADDR` requires `REPROLENS_ALLOW_REMOTE=true`; the local runner still requires a loopback address.

## 5. PDF evidence

`POST /api/v1/uploads/paper` accepts multipart field `file` and requires a `.pdf` extension. On `/start`, the project stores:

- `paper.text`: page text;
- `paper.pages[]`: page number, text, image path, dimensions, caption candidates;
- `paper.visuals[]`: rendered page image references.

`REPROLENS_LLM_VISION=true` enables OpenAI-compatible `image_url` content. The Analyzer retries text-only if the model rejects image input. PDF pages are still preserved in the evidence package even when the report evidence index omits paper/image entries.

## 6. SSE contract

`GET /api/v1/projects/{id}/events/stream` emits:

```text
retry: 3000

id: 42
event: reprolens
data: {"seq":42,...}

: heartbeat

event: done
data: {"state":"COMPLETED"}
```

- Supports multiple simultaneous clients.
- Supports `Last-Event-ID` and `after`.
- Sends heartbeat comments every 15 seconds.
- Handles write backpressure.
- Ends with `event: done` for terminal projects.
- Missing projects return `404` before the stream is hijacked.

## 7. Report and evidence maturity

The report contains:

- rule verdict and per-claim verification table;
- deterministic aggregate verdict: `FAILED > DIFFERENT > INSUFFICIENT_EVIDENCE > PASS`;
- evidence-maturity score and factors;
- main-agent Chinese summary with model/source/timestamp;
- plans, runs, patch approval, key events, and a compact evidence index.

The evidence-maturity score is not a scientific reproducibility claim. Single successful runs are capped at 60/C, host-local execution is capped at 65, and no successful run is capped at 20.

## 8. SSH contract

The SSH runner uses:

- `scp -O` to upload a tar.gz and generated run script;
- `ssh` to create the remote directory and run `bash run.sh`;
- nested `work_dir` containment validation;
- streamed stdout/stderr;
- remote evidence paths and job ids stored in the project aggregate.

Configuration:

```env
REPROLENS_RUNNER=ssh
REPROLENS_SSH_HOST=user@host
REPROLENS_SSH_PORT=22
REPROLENS_SSH_IDENTITY=/path/to/key
REPROLENS_SSH_BASE_DIR=/home/user/reprolens
REPROLENS_ENABLE_GPU=true
```

## 9. Security boundary

The default server is a trusted-local control plane. It does not provide authentication or multi-tenancy. Do not expose it to a network without a trusted authentication gateway. See `SECURITY.md`.
