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
    expect(health.headers['x-request-id']).toBeTruthy();
    const live = await server.inject({ method: 'GET', url: '/livez' });
    expect(live.statusCode).toBe(200);
    const ready = await server.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ready', database: 'ok', data_dir: 'ok' });
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
    const missingEvents = await server.inject({ method: 'GET', url: '/api/v1/projects/missing/events' });
    expect(missingEvents.statusCode).toBe(404);
    const malformed = await server.inject({
      method: 'POST', url: '/api/v1/projects', payload: '{', headers: { 'content-type': 'application/json' },
    });
    expect(malformed.statusCode).toBe(400);
  });

  it('returns 409 for invalid state actions without corrupting the project', async () => {
    const server = await app();
    const created = await server.inject({ method: 'POST', url: '/api/v1/demo', payload: {} });
    const project = created.json() as { id: string };
    const started = await server.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/start`, payload: {} });
    expect(started.statusCode).toBe(200);
    const repeated = await server.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/start`, payload: {} });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json()).toMatchObject({ error: { code: 'STATE_CONFLICT' } });
    const prematureConfirm = await server.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/plan/confirm`, payload: {} });
    expect(prematureConfirm.statusCode).toBe(409);
    const current = await server.inject({ method: 'GET', url: `/api/v1/projects/${project.id}` });
    expect(current.json()).toMatchObject({ state: 'AWAITING_CLAIMS' });
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

describe('idempotent operations', () => {
  it('replays a POST with the same idempotency key and exposes the operation log', async () => {
    const server = await app();
    const created = await server.inject({ method: 'POST', url: '/api/v1/demo', payload: {} });
    const project = created.json() as { id: string };
    const headers = { 'idempotency-key': 'http-start-1' };
    const first = await server.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/start`, payload: {}, headers });
    const second = await server.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/start`, payload: {}, headers });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ state: 'AWAITING_CLAIMS' });
    const operations = await server.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/operations` });
    expect(operations.statusCode).toBe(200);
    expect(operations.json()).toEqual([
      expect.objectContaining({ kind: 'start', status: 'succeeded', idempotency_key: 'http-start-1' }),
    ]);
  });
});
describe('event pagination', () => {
  it('returns a bounded page with cursor and has-more metadata', async () => {
    const server = await app();
    const created = await server.inject({ method: 'POST', url: '/api/v1/demo', payload: {} });
    const project = created.json() as { id: string };
    await server.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/start`, payload: {} });
    const first = await server.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/events?after=0&limit=1` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toHaveLength(1);
    expect(first.headers['x-has-more']).toBe('true');
    expect(first.headers['x-next-cursor']).toBe('1');
    const second = await server.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/events?after=1&limit=1` });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toHaveLength(1);
    const malformed = await server.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/events?after=12abc` });
    expect(malformed.statusCode).toBe(400);
    const negative = await server.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/events?limit=-1` });
    expect(negative.statusCode).toBe(400);
  });
});
describe('accepted background operations', () => {
  it('returns an operation id and replays a completed confirmation', async () => {
    const server = await app();
    const created = await server.inject({ method: 'POST', url: '/api/v1/demo', payload: {} });
    const project = created.json() as { id: string };
    await server.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/start`, payload: {} });
    await server.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/claims`, payload: { claim_ids: ['C1'] } });
    const headers = { 'idempotency-key': 'confirm-once' };
    const accepted = await server.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/plan/confirm`, payload: {}, headers });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ status: 'accepted', project_id: project.id });
    expect((accepted.json() as { operation_id?: string }).operation_id).toBeTruthy();
    let current = accepted.json() as { state?: string };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const projectResponse = await server.inject({ method: 'GET', url: `/api/v1/projects/${project.id}` });
      current = projectResponse.json() as { state?: string };
      if (current.state === 'AWAITING_PATCH') break;
    }
    expect(current.state).toBe('AWAITING_PATCH');
    const replay = await server.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/plan/confirm`, payload: {}, headers });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ project_id: project.id, state: 'AWAITING_PATCH' });
    const operations = await server.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/operations` });
    expect((operations.json() as Array<{ kind: string }>).filter((operation) => operation.kind === 'confirm_plan')).toHaveLength(1);
  });
});
describe('project revision concurrency', () => {
  it('exposes an ETag and rejects a stale If-Match update', async () => {
    const server = await app();
    const created = await server.inject({ method: 'POST', url: '/api/v1/demo', payload: {} });
    const project = created.json() as { id: string; revision?: number };
    expect(project.revision).toBe(1);
    await server.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/start`, payload: {} });
    const current = await server.inject({ method: 'GET', url: `/api/v1/projects/${project.id}` });
    expect(current.statusCode).toBe(200);
    const etag = current.headers.etag;
    expect(etag).toMatch(/^"rev-\d+"$/);
    const updated = await server.inject({
      method: 'PATCH', url: `/api/v1/projects/${project.id}/claims/C1`,
      payload: { text: 'edited claim' }, headers: { 'if-match': etag },
    });
    expect(updated.statusCode).toBe(200);
    const stale = await server.inject({
      method: 'PATCH', url: `/api/v1/projects/${project.id}/claims/C1`,
      payload: { text: 'stale edit' }, headers: { 'if-match': etag },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
  });
});
describe('idempotency request binding', () => {
  it('rejects reuse of an idempotency key with a different request body', async () => {
    const server = await app();
    const created = await server.inject({ method: 'POST', url: '/api/v1/demo', payload: {} });
    const project = created.json() as { id: string };
    await server.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/start`, payload: {} });
    const headers = { 'idempotency-key': 'claims-bound' };
    const first = await server.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/claims`, payload: { claim_ids: ['C1'] }, headers });
    expect(first.statusCode).toBe(200);
    const conflict = await server.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/claims`, payload: { claim_ids: ['C1', 'C2'] }, headers });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });
});});
