import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import AdmZip from 'adm-zip';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { OpenAICompatibleAnalyzer } from '../agent/openai.js';
import { applyRuntimeConfig, RuntimeSettings } from '../runtime.js';
import type { ConfigPatch } from '../config.js';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { materializeDemo } from '../demo.js';
import { ProjectBusyError, type Orchestrator } from '../orchestrator/orchestrator.js';
import { StoreNotFoundError } from '../store/store.js';
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
const approveBody = z.object({ approved_by: z.string().optional().default('local-user') }).strict();
const rejectBody = z.object({ reason: z.string().optional().default('patch rejected by user') }).strict();

export async function buildServer(orchestrator: Orchestrator, dataDir: string, settings?: RuntimeSettings): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  await app.register(fastifyStatic, { root: publicRoot, prefix: '/static/', wildcard: false });
  await app.register(fastifyStatic, { root: join(publicRoot, '..', 'node_modules', 'lucide', 'dist', 'esm'), prefix: '/vendor/lucide/', wildcard: true, decorateReply: false, index: false });
  await app.register(multipart, { limits: { fileSize: 128 * 1024 * 1024, files: 1 } });

  app.get('/healthz', async () => ({ status: 'ok', time: new Date().toISOString(), service: 'reprolens' }));
  app.get('/api/v1/projects', async () => orchestrator.listProjects());
  app.post('/api/v1/projects', async (request, reply) => {
    const body = parseBody(createProjectBody, request.body, reply);
    if (!body) return;
    const project = await orchestrator.createProject({
      name: body.name, paperPath: body.paper_path, repoPath: body.repo_path, dataPath: body.data_path,
      budget: body.budget as Partial<Budget> | undefined,
    });
    return reply.code(201).send(project);
  });
  app.post('/api/v1/demo', async (_request, reply) => {
    const demo = await materializeDemo(dataDir, `demo_${Date.now()}`);
    const project = await orchestrator.createProject({ name: 'Accuracy reproduction demo', paperPath: demo.paperPath, repoPath: demo.repoPath, budget: { max_runs: 3, max_seconds: 60, max_patches: 2 } });
    return reply.code(201).send(project);
  });
  app.get<{ Params: { id: string } }>('/api/v1/projects/:id', async (request) => orchestrator.getProject(request.params.id));
  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/start', async (request) => orchestrator.start(request.params.id));
  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/claims', async (request, reply) => {
    const body = parseBody(claimBody, request.body, reply);
    if (!body) return;
    return orchestrator.selectClaims(request.params.id, body.claim_ids);
  });
  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/plan/confirm', async (request, reply) => {
    const project = await orchestrator.getProject(request.params.id);
    void orchestrator.confirmPlan(project.id).catch((error: Error) => app.log.error({ error }, 'confirm plan failed'));
    return reply.code(202).send(project);
  });
  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/patch/approve', async (request, reply) => {
    const body = parseBody(approveBody, request.body ?? {}, reply);
    if (!body) return;
    const project = await orchestrator.getProject(request.params.id);
    void orchestrator.approvePatch(project.id, body.approved_by).catch((error: Error) => app.log.error({ error }, 'approve patch failed'));
    return reply.code(202).send(project);
  });
  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/patch/reject', async (request, reply) => {
    const body = parseBody(rejectBody, request.body ?? {}, reply);
    if (!body) return;
    return orchestrator.rejectPatch(request.params.id, body.reason);
  });
  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/stop', async (request) => orchestrator.stop(request.params.id));
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/v1/projects/:id/events', async (request) => {
    return orchestrator.events(request.params.id, Number.parseInt(request.query.after ?? '0', 10) || 0);
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/v1/projects/:id/events/stream', async (request, reply) => {
    const after = Number.parseInt(request.query.after ?? '0', 10) || 0;
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    request.raw.on('close', () => { closed = true; });
    let cursor = after;
    while (!closed) {
      try {
        const events = await orchestrator.events(request.params.id, cursor);
        for (const event of events) {
          reply.raw.write(`id: ${event.seq}\nevent: reprolens\ndata: ${JSON.stringify(event)}\n\n`);
          cursor = event.seq;
        }
        reply.raw.write(': keepalive\n\n');
      } catch (error) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify((error as Error).message)}\n\n`);
        break;
      }
      await sleep(1000);
    }
    reply.raw.end();
  });
  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/report.md', async (request, reply) => {
    const project = await orchestrator.getProject(request.params.id);
    if (!project.report) return reply.code(404).send({ error: { message: 'report is not ready' } });
    return reply.type('text/markdown; charset=utf-8').send(project.report.markdown);
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
    runners: ['auto', 'local', 'docker', 'ssh', 'colab', 'platform'],
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
    try {
      const next = await settings.update((request.body ?? {}) as ConfigPatch);
      applyRuntimeConfig(orchestrator, next, (message) => console.log(`[settings] ${message}`));
      return settings.publicSnapshot();
    } catch (error) {
      return reply.code(400).send({ error: { message: (error as Error).message } });
    }
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
    if (error instanceof StoreNotFoundError) return reply.code(404).send({ error: { message: 'project not found' } });
    if (error instanceof ProjectBusyError) return reply.code(409).send({ error: { message: error.message } });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { message: error.message } });
    if ((error as { statusCode?: number }).statusCode === 400) return reply.code(400).send({ error: { message: error.message } });
    return reply.code(500).send({ error: { message: error.message } });
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
