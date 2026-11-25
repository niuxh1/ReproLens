# ReproLens TypeScript 迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 ReproLens 从 Go 完整迁移为严格类型、可测试、可部署的 TypeScript/Node.js Agent，并保持既有功能与 API 契约。

**Architecture:** 使用 Node.js 24 + TypeScript 5 + Fastify + better-sqlite3 + Vitest。领域状态机与 JSON 契约独立于适配器；Analyzer、Runner、CodeAgent、Store 通过接口注入；CLI 和 HTTP 共享同一个 Orchestrator。

**Tech Stack:** Node.js 24, TypeScript 5, Fastify 5, better-sqlite3, Commander, Zod, Vitest, adm-zip, tar.

**Spec:** `docs/superpowers/specs/2026-11-25-typescript-migration-design.md`

## Global Constraints

- 必须使用 TypeScript 实现 Agent 核心，不允许保留 Go 入口或 `go.mod`。
- 所有 JSON 字段、状态名、动作名、CLI 命令、HTTP 路由保持现有契约。
- 最终核验 verdict 只能由 `src/tools/verify.ts` 的规则函数产生。
- 所有外部输入必须在边界校验；补丁路径必须防穿越。
- 每个任务先写失败测试，再写最小实现，测试通过后再重构。
- 提交前必须执行 `npm run typecheck`、`npm test`、`npm run build`。

---

### Task 1: 工程骨架与配置

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.npmrc` (if needed)
- Create: `src/config.ts`, `tests/config.test.ts`
- Modify: `.gitignore`, `.env.example`

**Interfaces:**
- Produces: `loadConfig(envPath?: string): Promise<Config>`, `Config` with nested `llm`, `codeAgent`, `remote`, `platform`.

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('loads defaults and accepts a local OpenAI-compatible endpoint', async () => {
    const cfg = await loadConfig('.env.test');
    expect(cfg.addr).toBe('127.0.0.1:8080');
    expect(cfg.llm.model).toBe('deepseek-v4.1-flash');
  });
});
```

- [ ] **Step 2: 运行失败测试**

Run: `npm test -- tests/config.test.ts`
Expected: fail because `src/config.ts` does not exist.

- [ ] **Step 3: 写最小实现**

实现默认值、`.env` 读取（不覆盖已存在的 `process.env`）、URL 校验、时长解析（`60s`, `10m`, `2h`）、布尔/数字解析、CodeAgent/Runner 校验。

- [ ] **Step 4: 验证通过**

Run: `npm test -- tests/config.test.ts`
Expected: pass.

- [ ] **Step 5: 提交**

```bash
git add package.json tsconfig.json tsconfig.build.json vitest.config.ts src/config.ts tests/config.test.ts .gitignore .env.example
git commit -m "chore: scaffold TypeScript runtime and configuration"
```

### Task 2: 领域状态机与类型

**Files:**
- Create: `src/domain/state.ts`, `src/domain/types.ts`, `src/domain/index.ts`
- Create: `tests/domain.test.ts`

**Interfaces:**
- Produces: `State`, `Action`, `canTransition(from, action): State | null`, `validateTransition`, `isTerminal`, `Budget.withDefaults()`.

- [ ] **Step 1: 写失败测试**

```ts
it('moves an approved patch into retry then execution', () => {
  expect(canTransition('AWAITING_PATCH', 'approve_patch')).toBe('RETRYING');
  expect(canTransition('RETRYING', 'retry_start')).toBe('EXECUTING');
  expect(canTransition('COMPLETED', 'stop')).toBeNull();
});
```

- [ ] **Step 2: 运行失败测试**

Run: `npm test -- tests/domain.test.ts`
Expected: fail because domain module is missing.

- [ ] **Step 3: 实现状态表与类型**

状态、动作使用 `as const` union；`TransitionMap` 以 `Partial<Record<State, Partial<Record<Action, State>>>>` 表达；所有领域类型使用现有 snake_case JSON 字段。

- [ ] **Step 4: 验证通过**

Run: `npm test -- tests/domain.test.ts`
Expected: pass.

- [ ] **Step 5: 提交**

```bash
git add src/domain tests/domain.test.ts
git commit -m "feat: port deterministic state machine to TypeScript"
```

### Task 3: Store 与 SQLite

**Files:**
- Create: `src/store/store.ts`, `src/store/memory-store.ts`, `src/store/sqlite-store.ts`, `src/store/index.ts`
- Create: `tests/store.test.ts`

**Interfaces:**
- Produces: `Store` interface with `createProject`, `getProject`, `saveProject`, `listProjects`, `appendEvent`, `listEvents`, `close`.
- Errors: `StoreNotFoundError`, `StoreDuplicateError`.

- [ ] **Step 1: 写失败测试**

测试 Memory 与 SQLite 的项目 round-trip、事件序号从 1 开始、`after=1` 过滤、缺失项目抛出 `StoreNotFoundError`。

- [ ] **Step 2: 运行失败测试**

Run: `npm test -- tests/store.test.ts`
Expected: fail because store modules are missing.

- [ ] **Step 3: 实现 Store**

SQLite schema 与 Go 版本一致；使用 `better-sqlite3` 的 `transaction` 写事件；JSON 序列化项目；事件 `data_json` 为空时返回 `{}`。

- [ ] **Step 4: 验证通过**

Run: `npm test -- tests/store.test.ts`
Expected: pass.

- [ ] **Step 5: 提交**

```bash
git add src/store tests/store.test.ts
git commit -m "feat: add TypeScript memory and SQLite stores"
```

### Task 4: Workspace、论文、仓库、补丁与核验

**Files:**
- Create: `src/tools/workspace.ts`, `src/tools/paper.ts`, `src/tools/repo.ts`, `src/tools/patch.ts`, `src/tools/verify.ts`, `src/tools/archive.ts`
- Create: `tests/tools.test.ts`, `tests/verify.test.ts`
- Create: `assets/demo/paper.md`, `assets/demo/repo/{README.md,run_experiment.py,data.csv}`

**Interfaces:**
- Produces: `Workspace`, `parsePaper(path)`, `scanRepo(root)`, `PatchManager.validate/apply/backup/restore`, `extractMetric`, `verifyMetric`, `verifyRun`, `createWorkspaceArchive`.

- [ ] **Step 1: 写失败测试**

覆盖 DOCX 文本抽取、README 命令候选、工作区穿越拒绝、补丁新增文件/修改文件、`PASS/DIFFERENT/INSUFFICIENT_EVIDENCE`、tar.gz 不包含 `.git`。

- [ ] **Step 2: 运行失败测试**

Run: `npm test -- tests/tools.test.ts tests/verify.test.ts`
Expected: fail because modules are missing.

- [ ] **Step 3: 实现工具层**

使用 `adm-zip` 读取 DOCX；使用 `tar` 创建 gzip 归档；使用 `git apply --check` 和 `git apply`；备份 manifest 支持回滚；数值规则不得依赖模型输出。

- [ ] **Step 4: 验证通过**

Run: `npm test -- tests/tools.test.ts tests/verify.test.ts`
Expected: pass.

- [ ] **Step 5: 提交**

```bash
git add src/tools tests/tools.test.ts tests/verify.test.ts assets/demo
git commit -m "feat: port ingestion, patch safety, archives, and verification"
```

### Task 5: Analyzer 与 OpenAI-compatible 适配

**Files:**
- Create: `src/agent/analyzer.ts`, `src/agent/heuristic.ts`, `src/agent/openai.ts`, `src/agent/fallback.ts`, `src/agent/index.ts`
- Create: `tests/agent.test.ts`

**Interfaces:**
- Produces: `Analyzer` with `extractClaims`, `buildPlan`, `diagnose`.
- Produces: `OpenAICompatibleAnalyzer` with constructor `{baseURL, apiKey, model, timeoutMs}`.

- [ ] **Step 1: 写失败测试**

测试 `Claim C1: accuracy = 0.81 (tolerance ±0.01)` 的 ID/值/行号；README 命令提取；seed mismatch diff；OpenAI endpoint `/chat/completions`、Bearer key、模型名；400 时去掉 response_format 重试；主分析器失败回退。

- [ ] **Step 2: 运行失败测试**

Run: `npm test -- tests/agent.test.ts`
Expected: fail because agent modules are missing.

- [ ] **Step 3: 实现**

使用 Zod 或显式守卫校验模型 JSON；清洗 claim ID、指标名、tolerance；限制最多 20 条 claim；错误响应只保留 600 字符；命令白名单与 Go 版本一致。

- [ ] **Step 4: 验证通过**

Run: `npm test -- tests/agent.test.ts`
Expected: pass.

- [ ] **Step 5: 提交**

```bash
git add src/agent tests/agent.test.ts
git commit -m "feat: port analyzers and OpenAI-compatible fallback"
```

### Task 6: CodeAgent 委派

**Files:**
- Create: `src/codeagent/code-agent.ts`, `src/codeagent/mock.ts`, `src/codeagent/command.ts`, `src/codeagent/index.ts`
- Create: `tests/codeagent.test.ts`

**Interfaces:**
- Produces: `CodeAgent.propose(task): Promise<CodeAgentResult>`, `CommandAgent` config `{command, appendPrompt, runAcceptance, timeoutMs}`.

- [ ] **Step 1: 写失败测试**

创建临时 workspace，用 Python fake agent 修改 `run.py` 并新增 `implementation.py`；断言返回 git diff、文件列表、日志路径；断言原 workspace 未被修改。

- [ ] **Step 2: 运行失败测试**

Run: `npm test -- tests/codeagent.test.ts`
Expected: fail because codeagent modules are missing.

- [ ] **Step 3: 实现**

复制 workspace 到 evidence/codeagent/<run>/workspace-*；初始化 git baseline；写 prompt；调用配置的 CLI；可选执行验收命令；`git diff --binary HEAD` 产出 diff；超时与空 diff 抛错。

- [ ] **Step 4: 验证通过**

Run: `npm test -- tests/codeagent.test.ts`
Expected: pass.

- [ ] **Step 5: 提交**

```bash
git add src/codeagent tests/codeagent.test.ts
git commit -m "feat: add isolated TypeScript code-agent delegation"
```

### Task 7: Runner 层与 Colab mock

**Files:**
- Create: `src/tools/runner.ts`, `src/tools/local-runner.ts`, `src/tools/docker-runner.ts`, `src/tools/ssh-runner.ts`, `src/tools/platform-runner.ts`, `src/platformmock/server.ts`
- Create: `tests/runners.test.ts`, `tests/platform.test.ts`

**Interfaces:**
- Produces: `Runner` with `name`, `execute(request): Promise<ExecutionResult>`.
- Produces: `PlatformRunner` implementing `/v1/offers`, `/v1/artifacts`, `/v1/jobs`, `/v1/jobs/:id`, `/v1/jobs/:id/logs`.

- [ ] **Step 1: 写失败测试**

覆盖 Local 捕获输出/证据、命令组合拒绝、Docker 参数含 `--network none` 与 GPU 参数、SSH 参数含端口/identity、Platform mock 首次失败第二次成功、offer 选择。

- [ ] **Step 2: 运行失败测试**

Run: `npm test -- tests/runners.test.ts tests/platform.test.ts`
Expected: fail because runner modules are missing.

- [ ] **Step 3: 实现**

使用 `child_process.spawn` + AbortSignal 实现超时；证据写到 `evidence/runs/<runId>/{stdout.log,stderr.log,manifest.json}`；平台上传使用 FormData，轮询支持 AbortSignal。

- [ ] **Step 4: 验证通过**

Run: `npm test -- tests/runners.test.ts tests/platform.test.ts`
Expected: pass.

- [ ] **Step 5: 提交**

```bash
git add src/tools/runner.ts src/tools/local-runner.ts src/tools/docker-runner.ts src/tools/ssh-runner.ts src/tools/platform-runner.ts src/platformmock tests/runners.test.ts tests/platform.test.ts
git commit -m "feat: port local, Docker, SSH, and rental-platform runners"
```

### Task 8: Orchestrator 与报告

**Files:**
- Create: `src/orchestrator/orchestrator.ts`, `src/orchestrator/execute.ts`, `src/orchestrator/index.ts`, `src/tools/report.ts`, `src/demo.ts`
- Create: `tests/orchestrator.test.ts`, `tests/report.test.ts`

**Interfaces:**
- Produces: `Orchestrator` methods `createProject`, `start`, `selectClaims`, `confirmPlan`, `approvePatch`, `rejectPatch`, `stop`, `getProject`, `listProjects`, `events`.
- Produces: `buildReport(project, events)`, `exportPackage(project, report, events)`.

- [ ] **Step 1: 写失败测试**

测试 demo 第一次执行失败、产生 `SEED = 0 -> 42` 补丁、审批后 `PASS`、报告 ZIP 存在；测试 Colab mock 路径；测试 stop/fail 终态。

- [ ] **Step 2: 运行失败测试**

Run: `npm test -- tests/orchestrator.test.ts tests/report.test.ts`
Expected: fail because orchestrator modules are missing.

- [ ] **Step 3: 实现**

保持 Go 版本的执行循环：预算检查、失败诊断、可选 CodeAgent、补丁验证、人工审批、重试、逐 claim 核验、报告导出；事件写入顺序不可破坏。

- [ ] **Step 4: 验证通过**

Run: `npm test -- tests/orchestrator.test.ts tests/report.test.ts`
Expected: pass.

- [ ] **Step 5: 提交**

```bash
git add src/orchestrator src/tools/report.ts src/demo.ts tests/orchestrator.test.ts tests/report.test.ts
git commit -m "feat: port orchestration, reporting, and demo workflow"
```

### Task 9: HTTP API、CLI 与静态控制台

**Files:**
- Create: `src/httpapi/server.ts`, `src/cli.ts`
- Move: `internal/httpapi/static/{index.html,app.js,style.css}` -> `src/httpapi/public/`
- Create: `tests/httpapi.test.ts`

**Interfaces:**
- Produces: Fastify `buildServer(orchestrator, dataDir)`.
- CLI commands: `serve`, `demo`, `colab-demo`, `ssh-demo`, `mock-colab`, `check-llm`, `version`.

- [ ] **Step 1: 写失败测试**

测试 `/healthz`、`POST /api/v1/demo`、`POST /api/v1/projects/:id/start`、`GET /events`、缺失项目 404、畸形 JSON 400；测试 CLI `--help`。

- [ ] **Step 2: 运行失败测试**

Run: `npm test -- tests/httpapi.test.ts`
Expected: fail because HTTP/CLI modules are missing.

- [ ] **Step 3: 实现**

Fastify 路由使用与 Go 版本相同的路径；`confirm`/`approve` 返回 202 并后台执行；SSE 每秒轮询事件；报告与 ZIP 用流式下载；CLI 用 Commander 解析。

- [ ] **Step 4: 验证通过**

Run: `npm test -- tests/httpapi.test.ts`
Expected: pass.

- [ ] **Step 5: 提交**

```bash
git add src/httpapi src/cli.ts tests/httpapi.test.ts
git commit -m "feat: add Fastify API and TypeScript CLI"
```

### Task 10: 清理 Go、更新文档与全量验收

**Files:**
- Delete: `cmd/`, `internal/`, `go.mod`, `go.sum`
- Modify: `README.md`, `docs/architecture.md`, `docs/api.md`, `docs/extension-points.md`, `docs/real-paper-test.md`, `docs/architecture-diagram.svg`, `docs/architecture-diagram.png`
- Modify: `package.json` scripts

- [ ] **Step 1: 删除 Go 入口与包**

确认 `git ls-files '*.go' go.mod go.sum` 为空；保留 `.work/` 忽略目录中的历史测试材料，不纳入交付物。

- [ ] **Step 2: 更新文档**

README 改为 npm 工作流；架构图技术栈改为 `TypeScript / Node.js / Fastify / SQLite`；扩展点示例改为 TypeScript 接口；API 命令改为 `npm run reprolens -- ...`。

- [ ] **Step 3: 全量验证**

Run:

```bash
npm run typecheck
npm test
npm run build
npm run demo -- --auto-approve
npm run colab-demo
```

Expected: 所有命令退出码 0；demo 输出 `PASS`；Colab demo 输出两次平台 run 且最终 `PASS`。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "refactor: replace Go implementation with TypeScript"
```

## Self-Review

- 覆盖：状态机、Store、摄取、Analyzer、CodeAgent、四类 Runner、Orchestrator、报告、HTTP、CLI、文档。
- 无占位符：每个任务包含实际测试行为、实现边界、验证命令与提交命令。
- 类型一致性：`snake_case` 领域字段贯穿 Store、API、报告；Runner/Analyzer/CodeAgent 均使用显式接口。
