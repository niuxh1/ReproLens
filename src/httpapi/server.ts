import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import AdmZip from 'adm-zip';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { OpenAICompatibleAnalyzer } from '../agent/openai.js';
import { inspectCommand } from '../codeagent/command.js';
import { buildReport } from '../tools/report.js';
import { renderReportErrorPage, renderReportPage } from './report-page.js';
import { applyRuntimeConfig, RuntimeSettings } from '../runtime.js';
import type { ConfigPatch } from '../config.js';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { materializeDemo } from '../demo.js';
import { IdempotencyConflictError, InvalidStateError, ProjectBusyError, ValidationError, type Orchestrator } from '../orchestrator/orchestrator.js';
import { StoreBusyError, StoreConflictError, StoreDuplicateError, StoreNotFoundError } from '../store/store.js';
import type { Budget } from '../domain/types.js';

const publicRoot = fileURLToPath(new URL('../../public/', import.meta.url));

const createProjectBody = z.object({
  name: z.string().optional().default(''),
  paper_path: z.string().min(1),
  repo_path: z.string().min(1),
  data_path: z.string().optional().default(''),
  budget: z.object({
    max_runs: z.number().int().optional(),
    max_seconds: z.number().int().optional(),
    max_patches: z.number().int().optional(),
  }).optional(),
}).strict();

const claimBody = z.object({ claim_ids: z.array(z.string()).min(1) }).strict();
const claimPatchBody = z.object({
  text: z.string().optional(),
  metric: z.string().optional(),
  expected_value: z.number().optional(),
  tolerance_abs: z.number().min(0).optional(),
}).strict();
const settingsPatchBody = z.object({
  runner: z.enum(['auto', 'local', 'docker', 'ssh']).optional(),
  enableGPU: z.boolean().optional(),
  llm: z.object({
    baseURL: z.string().optional(),
    apiKey: z.string().optional(),
    model: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    vision: z.boolean().optional(),
  }).strict().optional(),
  codeAgent: z.object({
    type: z.enum(['none', 'claude', 'codex', 'gemini', 'command']).optional(),
    command: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    runAcceptance: z.boolean().optional(),
  }).strict().optional(),
  remote: z.object({
    host: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    identity: z.string().optional(),
    baseDir: z.string().optional(),
  }).strict().optional(),
}).strict();

const approveBody = z.object({ approved_by: z.string().optional().default('local-user') }).strict();
const rejectBody = z.object({ reason: z.string().optional().default('patch rejected by user') }).strict();


export async function buildServer(orchestrator: Orchestrator, dataDir: string, settings?: RuntimeSettings): Promise<FastifyInstance> {
  const testing = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
  const app = Fastify({
    logger: testing ? false : {
      level: process.env.REPROLENS_LOG_LEVEL ?? 'info',
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.apiKey', '*.token', '*.password'],
        censor: '[REDACTED]',
      },
    },
    bodyLimit: 1024 * 1024,
  });
  await orchestrator.recoverInterruptedProjects();
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('x-reprolens-version', '0.3.0');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'SAMEORIGIN');
  });
  await app.register(fastifyStatic, { root: publicRoot, prefix: '/static/', wildcard: false, maxAge: '1h' });
  await app.register(multipart, { limits: { fileSize: 128 * 1024 * 1024, files: 1 } });

  app.get('/livez', async () => ({ status: 'ok', time: new Date().toISOString(), service: 'reprolens' }));
  app.get('/healthz', async () => {
    const readiness = await orchestrator.readiness();
    return { status: readiness.status === 'ready' ? 'ok' : 'degraded', time: new Date().toISOString(), service: 'reprolens', readiness };
  });
  app.get('/readyz', async (_request, reply) => {
    const readiness = await orchestrator.readiness();
    return reply.code(readiness.status === 'ready' ? 200 : 503).send({ ...readiness, time: new Date().toISOString(), service: 'reprolens' });
  });
  app.get('/api/v1/projects', async () => orchestrator.listProjects());
  app.post('/api/v1/projects', async (request, reply) => {
    const body = parseBody(createProjectBody, request.body, reply);
    if (!body) return;
    const project = await orchestrator.createProject({
      name: body.name, paperPath: body.paper_path, repoPath: body.repo_path, dataPath: body.data_path,
      budget: body.budget as Partial<Budget> | undefined,
    });
    reply.header('etag', etagFor(project));
    return reply.code(201).send(project);
  });
  app.post('/api/v1/demo', async (_request, reply) => {
    const demo = await materializeDemo(dataDir, `demo_${Date.now()}`);
    const project = await orchestrator.createProject({ name: 'Accuracy reproduction demo', paperPath: demo.paperPath, repoPath: demo.repoPath, budget: { max_runs: 3, max_seconds: 60, max_patches: 2 } });
    reply.header('etag', etagFor(project));
    return reply.code(201).send(project);
  });
  app.get<{ Params: { id: string } }>('/api/v1/projects/:id', async (request, reply) => {
    const project = await orchestrator.getProject(request.params.id);
    reply.header('etag', etagFor(project));
    reply.header('x-reprolens-revision', String(project.revision ?? 1));
    return project;
  });
  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/start', async (request) => {
    await enforceIfMatch(request, orchestrator, request.params.id);
    return orchestrator.start(request.params.id, idempotencyKey(request), operationRequestHash({ kind: 'start', project_id: request.params.id }));
  });
  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/claims', async (request, reply) => {
    const body = parseBody(claimBody, request.body, reply);
    if (!body) return;
    await enforceIfMatch(request, orchestrator, request.params.id);
    return orchestrator.selectClaims(request.params.id, body.claim_ids, idempotencyKey(request), operationRequestHash({ kind: 'select_claims', project_id: request.params.id, claim_ids: [...body.claim_ids].sort() }));
  });

  app.patch<{ Params: { id: string; claimId: string } }>('/api/v1/projects/:id/claims/:claimId', async (request, reply) => {
    const body = parseBody(claimPatchBody, request.body, reply);
    if (!body) return;
    await enforceIfMatch(request, orchestrator, request.params.id);
    return orchestrator.updateClaim(request.params.id, request.params.claimId, body);
  });
  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/plan/confirm', async (request, reply) => {
    await enforceIfMatch(request, orchestrator, request.params.id);
    const accepted = await orchestrator.acceptConfirmPlan(request.params.id, idempotencyKey(request), operationRequestHash({ kind: 'confirm_plan', project_id: request.params.id }));
    return reply.code(accepted.operation.status === 'succeeded' ? 200 : 202).send({
      project_id: accepted.project.id,
      operation_id: accepted.operation.id,
      status: accepted.operation.status === 'running' ? 'accepted' : accepted.operation.status,
      replayed: accepted.replayed,
      state: accepted.project.state,
    });
  });
  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/patch/approve', async (request, reply) => {
    const body = parseBody(approveBody, request.body ?? {}, reply);
    if (!body) return;
    await enforceIfMatch(request, orchestrator, request.params.id);
    const accepted = await orchestrator.acceptApprovePatch(request.params.id, body.approved_by, idempotencyKey(request), operationRequestHash({ kind: 'approve_patch', project_id: request.params.id, approved_by: body.approved_by }));
    return reply.code(accepted.operation.status === 'succeeded' ? 200 : 202).send({
      project_id: accepted.project.id,
      operation_id: accepted.operation.id,
      status: accepted.operation.status === 'running' ? 'accepted' : accepted.operation.status,
      replayed: accepted.replayed,
      state: accepted.project.state,
    });
  });
  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/patch/reject', async (request, reply) => {
    const body = parseBody(rejectBody, request.body ?? {}, reply);
    if (!body) return;
    await enforceIfMatch(request, orchestrator, request.params.id);
    return orchestrator.rejectPatch(request.params.id, body.reason, idempotencyKey(request), operationRequestHash({ kind: 'reject_patch', project_id: request.params.id, reason: body.reason }));
  });
  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/stop', async (request) => {
    await enforceIfMatch(request, orchestrator, request.params.id);
    return orchestrator.stop(request.params.id, idempotencyKey(request), operationRequestHash({ kind: 'stop', project_id: request.params.id }));
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>('/api/v1/projects/:id/events', async (request, reply) => {
    await orchestrator.getProject(request.params.id);
    const after = parseQueryInt(request.query.after, 'after', 0, 0);
    const limit = Math.min(10_000, parseQueryInt(request.query.limit, 'limit', 2000, 1));
    const events = await orchestrator.events(request.params.id, after, limit + 1);
    const page = events.slice(0, limit);
    const last = page.at(-1);
    reply.header('x-event-limit', String(limit));
    reply.header('x-has-more', String(events.length > limit));
    if (last) reply.header('x-next-cursor', String(last.seq));
    return page;
  });
  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/operations', async (request) => {
    await orchestrator.getProject(request.params.id);
    return orchestrator.operations(request.params.id);
  });  const eventWaiters = new Map<string, Set<() => void>>();
  const notifyEvents = (projectId: string): void => {
    for (const waiter of [...(eventWaiters.get(projectId) ?? [])]) waiter();
  };
  const unsubscribeEvents = orchestrator.onEvent((event) => notifyEvents(event.project_id));
  app.addHook('onClose', async () => {
    unsubscribeEvents();
    for (const waiters of eventWaiters.values()) for (const waiter of [...waiters]) waiter();
    eventWaiters.clear();
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/v1/projects/:id/events/stream', async (request, reply) => {
    const projectId = request.params.id;
    await orchestrator.getProject(projectId);
    const header = request.headers['last-event-id'];
    const rawAfter = (Array.isArray(header) ? header[0] : header) ?? request.query.after ?? '0';
    const after = Math.max(0, Number.parseInt(rawAfter, 10) || 0);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write('retry: 3000\n\n');
    let closed = false;
    let cursor = after;
    let wake: (() => void) | null = null;
    let lastHeartbeat = Date.now();
    const waiters = new Set<() => void>();
    const register = (waiter: () => void): void => {
      waiters.add(waiter);
      const all = eventWaiters.get(projectId) ?? new Set<() => void>();
      all.add(waiter);
      eventWaiters.set(projectId, all);
    };
    const unregister = (waiter: () => void): void => {
      waiters.delete(waiter);
      const all = eventWaiters.get(projectId);
      if (!all) return;
      all.delete(waiter);
      if (all.size === 0) eventWaiters.delete(projectId);
    };
    const close = (): void => {
      if (closed) return;
      closed = true;
      wake?.();
      for (const waiter of [...waiters]) unregister(waiter);
    };
    request.raw.on('close', close);
    try {
      while (!closed) {
        const events = await orchestrator.events(projectId, cursor, 200);
        for (const event of events) {
          const frame = `id: ${event.seq}\nevent: reprolens\ndata: ${JSON.stringify(event)}\n\n`;
          if (!reply.raw.write(frame)) await new Promise<void>((resolve) => reply.raw.once('drain', resolve));
          cursor = event.seq;
        }
        const current = await orchestrator.getProject(projectId).catch(() => null);
        if (current && ['COMPLETED', 'FAILED', 'STOPPED'].includes(current.state)) {
          reply.raw.write(`event: done\ndata: ${JSON.stringify({ state: current.state })}\n\n`);
          break;
        }
        if (Date.now() - lastHeartbeat >= 15_000) {
          reply.raw.write(': heartbeat\n\n');
          lastHeartbeat = Date.now();
        }
        await new Promise<void>((resolve) => {
          let timer: NodeJS.Timeout;
          const done = (): void => {
            clearTimeout(timer);
            unregister(done);
            resolve();
          };
          wake = done;
          register(done);
          timer = setTimeout(done, 1000);
        });
        wake = null;
      }
    } catch (error) {
      if (!closed) reply.raw.write(`event: error\ndata: ${JSON.stringify((error as Error).message)}\n\n`);
    } finally {
      close();
      reply.raw.end();
    }
  });
  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/report/summarize', async (request) => {
    await enforceIfMatch(request, orchestrator, request.params.id);
    return orchestrator.regenerateReportSummary(request.params.id, idempotencyKey(request), operationRequestHash({ kind: 'regenerate_report', project_id: request.params.id }));
  });
  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/report.md', async (request, reply) => {
    const project = await orchestrator.getProject(request.params.id);
    if (!project.report) return reply.code(404).send({ error: { message: 'report is not ready' } });
    return reply.type('text/markdown; charset=utf-8').send(project.report.markdown);
  });

  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/report.html', async (request, reply) => {
    reply.header('content-security-policy', "frame-ancestors 'self'");
    try {
      const project = await orchestrator.getProject(request.params.id);
      if (!project.report) return reply.code(404).type('text/html; charset=utf-8').send(renderReportErrorPage('报告尚未生成', '该项目尚未完成规则核验与报告生成。'));
      return reply.type('text/html; charset=utf-8').send(renderReportPage(project, project.report));
    } catch (error) {
      if (error instanceof StoreNotFoundError) {
        return reply.code(404).type('text/html; charset=utf-8').send(renderReportErrorPage('项目不存在', '该复现项目不存在或已被删除。'));
      }
      throw error;
    }
  });
  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/package', async (request, reply) => {
    const project = await orchestrator.getProject(request.params.id);
    if (!project.report?.package_path) return reply.code(404).send({ error: { message: 'reproduction package is not ready' } });
    const info = await stat(project.report.package_path).catch(() => null);
    if (!info?.isFile()) return reply.code(404).send({ error: { message: 'package file is missing' } });
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="${project.report.package_path.split(/[\\/]/).pop()}"`);
    return reply.send(createReadStream(project.report.package_path));
  });


  app.get<{ Params: { id: string; '*': string } }>('/api/v1/projects/:id/evidence/*', async (request, reply) => {
    const project = await orchestrator.getProject(request.params.id);
    const requested = request.params['*'];
    const root = resolve(project.evidence_dir);
    const target = resolve(root, requested);
    const rel = relative(root, target);
    if (!requested || rel === '..' || rel.startsWith(`..${sep}`) || resolve(target) === root) {
      return reply.code(400).send({ error: { message: 'invalid evidence path' } });
    }
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) return reply.code(404).send({ error: { message: 'evidence file not found' } });
    const extension = extname(target).toLowerCase();
    const mime = extension === '.png' ? 'image/png' : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.webp' ? 'image/webp' : extension === '.json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
    reply.header('Cache-Control', 'private, max-age=300');
    reply.type(mime);
    return reply.send(createReadStream(target));
  });
  app.get('/api/v1/options', async () => ({
    runners: ['auto', 'local', 'docker', 'ssh'],
    code_agents: ['none', 'claude', 'codex', 'gemini', 'command'],
    states: ['CREATED', 'INITIALIZED', 'INGESTED', 'AWAITING_CLAIMS', 'AWAITING_PLAN', 'SANDBOX_READY', 'EXECUTING', 'AWAITING_PATCH', 'RETRYING', 'VERIFYING', 'REPORTING', 'COMPLETED', 'FAILED', 'STOPPED'],
    model_presets: [
      { label: 'DeepSeek V4.1 Flash (local)', base_url: 'http://127.0.0.1:8788/v1', model: 'deepseek-v4.1-flash' },
      { label: 'OpenAI-compatible', base_url: '', model: '' },
    ],
  }));

  app.get('/api/v1/settings', async (_request, reply) => {
    if (!settings) return reply.code(503).send({ error: { message: 'runtime settings are unavailable' } });
    return settings.publicSnapshot();
  });

  app.put('/api/v1/settings', async (request, reply) => {
    if (!settings) return reply.code(503).send({ error: { message: 'runtime settings are unavailable' } });
    const body = parseBody(settingsPatchBody, request.body, reply);
    if (!body) return;
    try {
      const next = await settings.update(body as ConfigPatch);
      applyRuntimeConfig(orchestrator, next, (message) => console.log(`[settings] ${message}`));
      return settings.publicSnapshot();
    } catch (error) {
      return reply.code(400).send({ error: { message: (error as Error).message } });
    }
  });



  app.post('/api/v1/settings/test-code-agent', async (_request, reply) => {
    if (!settings) return reply.code(503).send({ error: { message: 'runtime settings are unavailable' } });
    const config = settings.current.codeAgent;
    if (config.type === 'none') return { ok: true, configured: false, available: false, type: 'none' };
    const inspection = await inspectCommand(config.command);
    return {
      ok: inspection.available,
      configured: true,
      type: config.type,
      executable: inspection.executable,
      ...(inspection.path ? { path: inspection.path } : {}),
      ...(inspection.version ? { version: inspection.version } : {}),
    };
  });

  app.post('/api/v1/settings/test-llm', async (_request, reply) => {
    if (!settings) return reply.code(503).send({ error: { message: 'runtime settings are unavailable' } });
    const config = settings.current;
    if (!config.llm.baseURL) return reply.code(400).send({ error: { message: 'LLM base URL is not configured' } });
    try {
      const analyzer = new OpenAICompatibleAnalyzer({ baseURL: config.llm.baseURL, apiKey: config.llm.apiKey, model: config.llm.model, timeoutMs: config.llm.timeoutMs, vision: config.llm.vision });
      const probe = { title: 'Probe', text: 'Claim C1: accuracy = 0.81 (tolerance ±0.01).', source_path: 'probe.md', sha256: '', claims: [], parsed_at: new Date().toISOString() };
      const claims = await analyzer.extractClaims(probe, { root: '', files: [], command_candidates: [], scanned_at: new Date().toISOString() });
      return { ok: true, model: config.llm.model, claims };
    } catch (error) {
      return reply.code(502).send({ error: { message: (error as Error).message } });
    }
  });

  app.post('/api/v1/uploads/paper', async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: { message: 'missing paper file' } });
    if (extname(file.filename).toLowerCase() !== '.pdf') return reply.code(400).send({ error: { message: 'paper upload must be a PDF' } });
    const data = await file.toBuffer();
    const uploadDir = join(dataDir, 'uploads');
    await mkdir(uploadDir, { recursive: true });
    const paperPath = join(uploadDir, `paper_${randomUUID()}.pdf`);
    await writeFile(paperPath, data);
    return reply.code(201).send({ paper_path: paperPath, filename: basename(file.filename), size: data.length });
  });

  app.post('/api/v1/uploads/repo', async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: { message: 'missing repository archive' } });
    if (extname(file.filename).toLowerCase() !== '.zip') return reply.code(400).send({ error: { message: 'repository upload must be a ZIP' } });
    const data = await file.toBuffer();
    const repoRoot = join(dataDir, 'uploads', 'repos', `repo_${randomUUID()}`);
    await mkdir(repoRoot, { recursive: true });
    try {
      const zip = new AdmZip(data);
      const entries = zip.getEntries();
      if (entries.length > 5000) throw new Error('repository archive exceeds 5000 entries');
      let total = 0;
      for (const entry of entries) {
        const name = entry.entryName.replace(/\\/g, '/');
        if (name.startsWith('/') || name.includes('../') || name.includes('\0')) throw new Error(`unsafe archive entry: ${entry.entryName}`);
        if (entry.isDirectory) {
          await mkdir(join(repoRoot, ...name.split('/')), { recursive: true });
          continue;
        }
        const content = entry.getData();
        total += content.length;
        if (total > 256 * 1024 * 1024) throw new Error('repository archive exceeds 256 MiB');
        const target = join(repoRoot, ...name.split('/'));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      }
      return reply.code(201).send({ repo_path: repoRoot, filename: basename(file.filename), size: data.length });
    } catch (error) {
      return reply.code(400).send({ error: { message: (error as Error).message } });
    }
  });
  app.get('/', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/static/*', async (_request, reply) => reply.code(404).send({ error: { message: 'static file not found' } }));

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error instanceof StoreNotFoundError) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'project not found' } });
    if (error instanceof StoreDuplicateError) return reply.code(409).send({ error: { code: 'ALREADY_EXISTS', message: error.message } });
    if (error instanceof StoreBusyError) return reply.code(409).send({ error: { code: 'PROJECT_BUSY', message: error.message } });
    if (error instanceof StoreConflictError) return reply.code(409).send({ error: { code: 'REVISION_CONFLICT', message: error.message } });
    if (error instanceof IdempotencyConflictError) return reply.code(409).send({ error: { code: 'IDEMPOTENCY_CONFLICT', message: error.message } });
    if (error instanceof InvalidStateError || error instanceof ProjectBusyError) return reply.code(409).send({ error: { code: 'STATE_CONFLICT', message: error.message } });
    if (error instanceof ValidationError) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: error.message } });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: error.message } });
    if ((error as { statusCode?: number }).statusCode === 400) return reply.code(400).send({ error: { message: error.message } });
    const message = process.env.NODE_ENV === 'production' ? 'internal server error' : error.message;
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message } });
  });
  return app;
}

function parseBody<T>(schema: z.ZodType<T>, raw: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    void reply.code(400).send({ error: { message: result.error.message } });
    return null;
  }
  return result.data;
}

async function enforceIfMatch(request: FastifyRequest, orchestrator: Orchestrator, projectId: string): Promise<void> {
  const raw = request.headers['if-match'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value?.trim()) return;
  const match = /^(?:W\/)?"?rev-(\d+)"?$/.exec(value.trim()) ?? /^"?(\d+)"?$/.exec(value.trim());
  if (!match) throw new StoreConflictError('invalid If-Match header; expected "rev-N"');
  const project = await orchestrator.getProject(projectId);
  if (Number(match[1]) !== (project.revision ?? 1)) throw new StoreConflictError();
}

function parseQueryInt(raw: string | undefined, name: string, fallback: number, min: number): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    const error = new Error(`${name} must be a non-negative integer`) as Error & { statusCode: number };
    error.statusCode = 400;
    throw error;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) {
    const error = new Error(`${name} must be at least ${min}`) as Error & { statusCode: number };
    error.statusCode = 400;
    throw error;
  }
  return value;
}
function operationRequestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function etagFor(project: { revision?: number }): string {
  return `"rev-${project.revision ?? 1}"`;
}
function idempotencyKey(request: FastifyRequest): string | undefined {
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const key = value?.trim();
  if (!key) return undefined;
  if (key.length > 160) throw new ValidationError('idempotency key must be 160 characters or fewer');
  if (/[\u0000-\u001f\u007f]/.test(key)) throw new ValidationError('idempotency key contains control characters');
  return key;
}
