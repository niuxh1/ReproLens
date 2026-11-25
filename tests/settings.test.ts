import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/httpapi/server.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { HeuristicAnalyzer } from '../src/agent/heuristic.js';
import { LocalRunner } from '../src/tools/local-runner.js';
import { RuntimeSettings } from '../src/runtime.js';
import type { Config } from '../src/config.js';

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function baseConfig(): Config {
  return {
    addr: '127.0.0.1:8080', dataDir: '.', runner: 'auto', enableGPU: false,
    codeAgent: { type: 'none', command: '', timeoutMs: 600000, runAcceptance: false },
    llm: { baseURL: 'http://127.0.0.1:8788/v1', apiKey: 'secret-key-1234', model: 'deepseek-v4.1-flash', timeoutMs: 60000, vision: true },
    remote: { host: '', port: 22, identity: '', baseDir: '/tmp/reprolens' },
    platform: { baseURL: '', apiKey: '', provider: 'colab', image: 'python:3.11-slim', gpuType: '', minVRAMGB: 0, maxHourlyUSD: 1, pollIntervalMs: 2000, timeoutMs: 1800000 },
  };
}

async function setup(): Promise<{ app: FastifyInstance; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'reprolens-settings-'));
  dirs.push(dir);
  const config = { ...baseConfig(), dataDir: dir };
  const orchestrator = new Orchestrator(new MemoryStore(), new HeuristicAnalyzer(), new LocalRunner(), dir);
  const settings = new RuntimeSettings(config, dir);
  const app = await buildServer(orchestrator, dir, settings);
  apps.push(app); await app.ready();
  return { app, dir };
}

describe('runtime settings API', () => {
  it('masks secrets, persists updates, and keeps the existing key when omitted', async () => {
    const { app, dir } = await setup();
    const initial = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().llm.apiKey).toMatch(/^••••••••/);
    const updated = await app.inject({ method: 'PUT', url: '/api/v1/settings', payload: { runner: 'local', enableGPU: true, llm: { model: 'test-model', timeoutMs: 1000, vision: false } } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ runner: 'local', enableGPU: true, llm: { model: 'test-model', vision: false } });
    const persisted = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
    expect(persisted.llm.apiKey).toBe('secret-key-1234');
  });

  it('rejects an invalid URL without corrupting settings', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'PUT', url: '/api/v1/settings', payload: { llm: { baseURL: 'not-a-url' } } });
    expect(response.statusCode).toBe(400);
  });
});
