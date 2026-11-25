import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildServer } from '../src/httpapi/server.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { HeuristicAnalyzer } from '../src/agent/heuristic.js';
import { LocalRunner } from '../src/tools/local-runner.js';
import type { FastifyInstance } from 'fastify';

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function app(): Promise<FastifyInstance> {
  const dir = await mkdtemp(join(tmpdir(), 'reprolens-http-'));
  dirs.push(dir);
  const server = await buildServer(new Orchestrator(new MemoryStore(), new HeuristicAnalyzer(), new LocalRunner(), dir), dir);
  apps.push(server);
  await server.ready();
  return server;
}

describe('HTTP API', () => {
  it('serves health and the dashboard', async () => {
    const server = await app();
    const health = await server.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok', service: 'reprolens' });
    const index = await server.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('ReproLens');
  });

  it('creates a demo, starts ingestion, and exposes events', async () => {
    const server = await app();
    const created = await server.inject({ method: 'POST', url: '/api/v1/demo', payload: {} });
    expect(created.statusCode).toBe(201);
    const project = created.json() as { id: string; state: string };
    expect(project.state).toBe('CREATED');
    const started = await server.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/start` });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ state: 'AWAITING_CLAIMS' });
    const events = await server.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/events` });
    expect(events.statusCode).toBe(200);
    const body = events.json() as Array<{ seq: number }>;
    expect(body[0]?.seq).toBe(1);
  });

  it('returns 404 for missing projects and 400 for malformed JSON', async () => {
    const server = await app();
    const missing = await server.inject({ method: 'GET', url: '/api/v1/projects/missing' });
    expect(missing.statusCode).toBe(404);
    const malformed = await server.inject({
      method: 'POST', url: '/api/v1/projects', payload: '{', headers: { 'content-type': 'application/json' },
    });
    expect(malformed.statusCode).toBe(400);
  });
});
describe('project evidence preview', () => {
  it('serves a contained page image and rejects unsafe paths', async () => {
    const server = await app();
    const created = await server.inject({ method: 'POST', url: '/api/v1/demo', payload: {} });
    const project = created.json() as { id: string };
    await server.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/start`, payload: {} });
    await mkdir(join(dirs[0]!, 'projects', project.id, 'evidence', 'paper'), { recursive: true });
    await writeFile(join(dirs[0]!, 'projects', project.id, 'evidence', 'paper', 'page-001.png'), Buffer.from('fake-page'));
    const response = await server.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/evidence/paper/page-001.png` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
    const escaped = await server.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/evidence/..%2Fsecret.txt` });
    expect([400, 404]).toContain(escaped.statusCode);
    const missing = await server.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/evidence/missing.png` });
    expect(missing.statusCode).toBe(404);
  });
});

describe('streaming execution transcript', () => {
  it('emits stdout chunks while a command is running', async () => {
    const server = await app();
    const created = await server.inject({ method: 'POST', url: '/api/v1/projects', payload: { paper_path: resolve('assets/demo/paper.md'), repo_path: resolve('assets/demo/repo') } });
    const project = created.json() as { id: string };
    await server.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/start`, payload: {} });
    await server.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/claims`, payload: { claim_ids: ['C1'] } });
    await server.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/plan/confirm`, payload: {} });
    let events: Array<{ type: string; data?: Record<string, unknown> }> = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      events = (await server.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/events` })).json() as typeof events;
      if (events.some((event) => event.type === 'run_completed') && events.some((event) => event.type === 'run_output')) break;
    }

    expect(events.some((event) => event.type === 'run_started')).toBe(true);
    expect(events.some((event) => event.type === 'run_output')).toBe(true);
    expect(events.some((event) => event.type === 'run_completed')).toBe(true);
  });
});
