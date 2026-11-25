# ReproLens Extension Points

This document defines the switchable surfaces exposed by the TypeScript runtime and the Web console. The core workflow does not need to be rewritten when a provider changes.

## 1. Analyzer

```ts
export interface Analyzer {
  extractClaims(paper: Paper, repo: RepoSummary): Promise<Claim[]>;
  buildPlan(claim: Claim, paper: Paper, repo: RepoSummary): Promise<ExperimentPlan>;
  diagnose(run: Run, repo: RepoSummary, workspace: string): Promise<Diagnosis>;
}
```

Implementations:

- `HeuristicAnalyzer`: deterministic offline analyzer.
- `OpenAICompatibleAnalyzer`: local or remote OpenAI-compatible endpoint, including optional PDF page images.
- `FallbackAnalyzer`: tries the primary analyzer and falls back to deterministic logic.

Switch with `REPROLENS_LLM_BASE_URL`, `REPROLENS_LLM_MODEL`, `REPROLENS_LLM_API_KEY`, and `REPROLENS_LLM_VISION`.

## 2. Runner

```ts
export interface Runner {
  name(): string;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}
```

| Runner | Use |
|---|---|
| `LocalRunner` | Demo/test only; labeled unsafe |
| `DockerRunner` | Isolated local execution |
| `SSHRunner` | Remote host via scp/ssh |
| `PlatformRunner` | Colab-style rental platform |
| Fake runner | Unit/integration tests |

Switch with `REPROLENS_RUNNER=auto|local|docker|ssh|colab|platform`, or from the Web console.

## 3. CodeAgent

```ts
export interface CodeAgent {
  name(): string;
  propose(task: CodeAgentTask): Promise<CodeAgentResult>;
}
```

Implementations:

- `MockCodeAgent`: deterministic tests.
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

The agent is invoked only when the diagnosis says `needs_code_agent` and no safe patch exists. It receives a disposable workspace copy. Its diff is validated and held for human approval.

## 4. Store

```ts
export interface Store {
  createProject(project: Project): Promise<void>;
  getProject(id: string): Promise<Project>;
  saveProject(project: Project): Promise<void>;
  appendEvent(projectId: string, type: string, message: string, data?: Record<string, unknown>): Promise<Event>;
  listEvents(projectId: string, after?: number): Promise<Event[]>;
}
```

Implementations:

- `MemoryStore`: fast tests.
- `SqliteStore`: persistent project aggregate + append-only events.

## 5. PDF visual evidence

`parsePaper(path, { visualDir })` returns:

```ts
interface Paper {
  text: string;
  pages?: PaperPage[];
  visuals?: PaperVisual[];
}
```

Each page contains text, rendered PNG path, dimensions, and caption candidates. This gives the Analyzer and report access to visual information without discarding the original PDF layout.

## 6. GPU

GPU is a runner capability, recorded in run evidence:

- Local: sets `CUDA_VISIBLE_DEVICES=0` and `NVIDIA_VISIBLE_DEVICES=all`.
- Docker: adds `--gpus all` and GPU environment variables.
- SSH: exports GPU variables in the remote run script.
- Slurm/platform: records the selected GPU offer and provider.

Switch with `REPROLENS_ENABLE_GPU=true` or the Web console.

## 7. Human approval

Approval is a separate action, not a provider switch:

```ts
const project = await orchestrator.approvePatch(projectId, approvedBy);
```

No CodeAgent, model, runner, or platform can skip this gate. `rejectPatch` records the reason and terminates the workflow.

## 8. Web and MCP integration

A future Web/MCP backend can:

1. Build `Config` from its own form or settings API.
2. Choose an `Analyzer`, `Runner`, and `CodeAgent` implementation.
3. Construct `new Orchestrator(store, analyzer, runner, dataDir)`.
4. Call `setCodeAgent` when CodeAgent is enabled.
5. Expose the orchestrator methods as API endpoints.
6. Read `Project`, `Event`, `Verification`, and `Report` values.

The current Fastify server is a reference implementation and is not required by the core agent.

## 9. Safe defaults

- `REPROLENS_CODE_AGENT=none`
- `REPROLENS_RUNNER=auto` (Docker if available, otherwise local loopback demo)
- `REPROLENS_ENABLE_GPU=false`
- Human approval required for every patch.
