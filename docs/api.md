# ReproLens API and HTTP Contract

The Fastify API and Codex-style dashboard are optional front ends. The core agent is usable from TypeScript, CLI, or a future MCP adapter.

## 1. Agent HTTP API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Health check |
| `GET` | `/api/v1/options` | Runners, CodeAgents, states, model presets |
| `GET` | `/api/v1/settings` | Masked runtime settings |
| `PUT` | `/api/v1/settings` | Persist and apply model/runner/CodeAgent settings |
| `POST` | `/api/v1/settings/test-llm` | Probe the configured OpenAI-compatible endpoint |
| `POST` | `/api/v1/uploads/paper` | Upload a PDF and return a server-side path |
| `POST` | `/api/v1/uploads/repo` | Upload a repository ZIP and return an extracted directory |
| `GET` | `/api/v1/projects` | List projects |
| `POST` | `/api/v1/projects` | Create a project from paper/repo paths |
| `POST` | `/api/v1/demo` | Materialize and create the bundled demo |
| `GET` | `/api/v1/projects/{id}` | Read project aggregate |
| `POST` | `/api/v1/projects/{id}/start` | Init, ingest, render PDF pages, extract claims |
| `POST` | `/api/v1/projects/{id}/claims` | Select claims and build plans |
| `POST` | `/api/v1/projects/{id}/plan/confirm` | Start async execution |
| `POST` | `/api/v1/projects/{id}/patch/approve` | Approve patch and retry |
| `POST` | `/api/v1/projects/{id}/patch/reject` | Reject patch and stop |
| `POST` | `/api/v1/projects/{id}/stop` | Stop active job |
| `GET` | `/api/v1/projects/{id}/events` | Read events after a sequence |
| `GET` | `/api/v1/projects/{id}/events/stream` | SSE event stream |
| `GET` | `/api/v1/projects/{id}/report.md` | Download Markdown report |
| `GET` | `/api/v1/projects/{id}/report.html` | Render the readable/printable Chinese report |
| `POST` | `/api/v1/projects/{id}/report/summarize` | Regenerate the main-agent summary and report package |
| `GET` | `/api/v1/projects/{id}/package` | Download ZIP evidence package |

### Create project

```json
{
  "name": "Grokfast reproduction",
  "paper_path": "C:\\research\\paper.pdf",
  "repo_path": "C:\\research\\official-repo",
  "data_path": "C:\\research\\data",
  "budget": {"max_runs": 3, "max_seconds": 900, "max_patches": 2}
}
```

### Runtime settings

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
  "codeAgent": {"type": "codex", "command": "codex exec --approve-for-me --ephemeral"}
}
```

API keys are returned masked. Omit `apiKey` or send an empty value to keep the existing key.

## 2. PDF evidence

`POST /api/v1/uploads/paper` accepts multipart field `file` and requires a `.pdf` extension. On `/start`, the project stores:

- `paper.text`: page text;
- `paper.pages[]`: page number, text, image path, dimensions, caption candidates;
- `paper.visuals[]`: rendered page image references.

`REPROLENS_LLM_VISION=true` enables OpenAI-compatible `image_url` content. The Analyzer retries text-only if the model rejects image input.

## 3. SSH contract

The SSH runner uses:

- `scp -O` to upload a tar.gz and generated run script;
- `ssh` to create the remote directory and run `bash run.sh`;
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
## 3. SSH contract

The SSH runner uses:

- `scp -O` to upload a tar.gz and generated run script;
- `ssh` to create the remote directory and run `bash run.sh`;
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
