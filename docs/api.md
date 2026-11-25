# ReproLens API and Platform Contract

The HTTP API and dashboard are optional. The core agent is usable from Go, CLI, or a future web frontend.

## 1. Agent HTTP API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/projects` | Create a project from paper/repo paths |
| `POST` | `/api/v1/demo` | Materialize and create the bundled demo |
| `POST` | `/api/v1/projects/{id}/start` | Init, ingest, extract claims |
| `POST` | `/api/v1/projects/{id}/claims` | Select claims and build plans |
| `POST` | `/api/v1/projects/{id}/plan/confirm` | Start async execution |
| `POST` | `/api/v1/projects/{id}/patch/approve` | Approve patch and retry |
| `POST` | `/api/v1/projects/{id}/patch/reject` | Reject patch and stop |
| `POST` | `/api/v1/projects/{id}/stop` | Cancel active job |
| `GET` | `/api/v1/projects/{id}` | Get aggregate state |
| `GET` | `/api/v1/projects/{id}/events?after=N` | Poll event log |
| `GET` | `/api/v1/projects/{id}/events/stream` | SSE event stream |
| `GET` | `/api/v1/projects/{id}/report.md` | Download Markdown report |
| `GET` | `/api/v1/projects/{id}/package` | Download ZIP reproduction package |

The API does not set verdicts; it only reads the state produced by the orchestrator and verifier.

## 2. Colab-compatible platform contract

PlatformRunner expects a provider-neutral HTTP API. A real rental platform adapter can implement this contract.

### GET /v1/offers

```json
{
  "offers": [
    {
      "id": "colab-t4",
      "provider": "colab",
      "gpu_type": "T4",
      "vram_gb": 16,
      "hourly_usd": 0.0,
      "available": true
    }
  ]
}
```

### POST /v1/artifacts

Multipart form with field `file` containing `workspace.tar.gz`.

```json
{"artifact_id": "artifact_1"}
```

### POST /v1/jobs

```json
{
  "offer_id": "colab-t4",
  "artifact_id": "artifact_1",
  "command": "python run_experiment.py --seed 42",
  "image": "python:3.11-slim",
  "gpu": true,
  "timeout_seconds": 600,
  "env": {"REPROLENS_SEED": "42"}
}
```

```json
{"job_id": "job_1", "status": "queued"}
```

### GET /v1/jobs/{id}

```json
{"job_id": "job_1", "status": "running", "exit_code": 0}
```

Terminal statuses: `succeeded`, `failed`, `cancelled`, `canceled`, `timeout`.

### GET /v1/jobs/{id}/logs

```json
{"stdout": "accuracy=0.81\n", "stderr": "", "exit_code": 0, "status": "succeeded"}
```

## 3. Mock platform

`internal/platformmock` implements this contract with T4/L4/A100 offers and a simulated seed-mismatch experiment.

```powershell
go run ./cmd/reprolens mock-colab --addr 127.0.0.1:8789
```

Or use the fully in-process demo:

```powershell
go run ./cmd/reprolens colab-demo
```

## 4. SSH contract

The SSH runner uses:

- `scp -O` to upload a tar.gz and generated run script;
- `ssh` to create the remote directory and run `bash run.sh`;
- remote evidence paths and job ids are stored in the project aggregate.

Configuration:

```env
REPROLENS_RUNNER=ssh
REPROLENS_SSH_HOST=user@host
REPROLENS_SSH_PORT=22
REPROLENS_SSH_IDENTITY=/path/to/key
REPROLENS_SSH_BASE_DIR=/home/user/reprolens
REPROLENS_ENABLE_GPU=true
```