import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformRunner } from '../src/tools/platform-runner.js';
import { Workspace } from '../src/tools/workspace.js';
import { startPlatformMock } from '../src/platformmock/server.js';

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('platform runner and Colab-style mock', () => {
  it('selects a GPU offer, retries after a simulated patch, and returns evidence', async () => {
    const mock = await startPlatformMock();
    closers.push(mock.close);
    const dir = await mkdtemp(join(tmpdir(), 'reprolens-platform-'));
    dirs.push(dir);
    const ws = await Workspace.create(dir, 'platform_project');
    const script = join(ws.root, 'run_experiment.py');
    await writeFile(script, "SEED = 0\nprint('accuracy=0.50')\n");
    const runner = new PlatformRunner({
      baseURL: mock.url, provider: 'colab', image: 'python:3.11-slim', minVRAMGB: 16, maxHourlyUSD: 0.5, pollIntervalMs: 20, timeoutMs: 5000, enableGPU: true,
    });
    const first = await runner.execute({
      projectId: 'platform_project', runId: 'run_fail', workspace: ws.root, evidenceDir: ws.evidenceDir,
      command: 'python run_experiment.py --seed 42', workDir: '.', seed: 42, timeoutMs: 5000,
    });
    expect(first.status).toBe('failed');
    expect(first.offerId).toBe('colab-t4');
    expect(first.gpu).toBe(true);
    expect(first.stderr).toContain('seed mismatch');
    expect(first.remoteJobId).toBeTruthy();
    await writeFile(script, "SEED = 42\nprint('accuracy=0.81')\n");
    const second = await runner.execute({
      projectId: 'platform_project', runId: 'run_pass', workspace: ws.root, evidenceDir: ws.evidenceDir,
      command: 'python run_experiment.py --seed 42', workDir: '.', seed: 42, timeoutMs: 5000,
    });
    expect(second.status).toBe('succeeded');
    expect(second.stdout).toContain('accuracy=0.81');
    expect(second.offerId).toBe('colab-t4');
  });
});
