import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRunner } from '../src/tools/local-runner.js';
import { DockerRunner } from '../src/tools/docker-runner.js';
import { SSHRunner } from '../src/tools/ssh-runner.js';
import { Workspace } from '../src/tools/workspace.js';
import { runProcess } from '../src/tools/runner.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), 'reprolens-runner-'));
  dirs.push(dir);
  return Workspace.create(dir, 'runner_project');
}

describe('local runner', () => {
  it('captures stdout/stderr and writes evidence', async () => {
    const ws = await workspace();
    const result = await new LocalRunner().execute({
      projectId: 'runner_project', runId: 'run_1', workspace: ws.root, evidenceDir: ws.evidenceDir,
      command: 'node -e "console.log(\'ok\')"', workDir: '.', seed: 42, timeoutMs: 10_000,
    });
    expect(result.status).toBe('succeeded');
    expect(result.stdout).toContain('ok');
    expect(result.stdoutPath).toBeTruthy();
    expect((await stat(result.stdoutPath!)).isFile()).toBe(true);
    expect(JSON.parse(await readFile(join(ws.evidenceDir, 'runs', 'run_1', 'manifest.json'), 'utf8')).status).toBe('succeeded');
  });

  it('caps retained output while still emitting stream chunks', async () => {
    const chunks: string[] = [];
    const outcome = await runProcess('node', ['-e', 'process.stdout.write("x".repeat(5000))'], {
      timeoutMs: 5000,
      maxOutputBytes: 100,
      onOutput: (stream, text) => { if (stream === 'stdout') chunks.push(text); },
    });
    expect(outcome.stdout.length).toBeLessThanOrEqual(100);
    expect(outcome.stdoutTruncated).toBe(true);
    expect(chunks.join('').length).toBeGreaterThan(1000);
  });

  it('rejects shell composition', async () => {
    const ws = await workspace();
    await expect(new LocalRunner().execute({
      projectId: 'runner_project', runId: 'run_2', workspace: ws.root, evidenceDir: ws.evidenceDir,
      command: 'node -e "console.log(1)" && echo bad', workDir: '.', seed: 42, timeoutMs: 1000,
    })).rejects.toThrow(/shell composition/);
  });
});

describe('docker runner argument construction', () => {
  it('builds isolated and GPU-enabled arguments', async () => {
    const ws = await workspace();
    const runner = new DockerRunner({ enableGPU: true });
    const args = runner.buildArgs({
      projectId: 'runner_project', runId: 'run_1', workspace: ws.root, evidenceDir: ws.evidenceDir,
      command: 'python run.py', image: 'python:3.11-slim', workDir: 'experiments', seed: 42, timeoutMs: 1000,
    }, '/workspace/experiments');
    expect(args).toContain('--network');
    expect(args).toContain('none');
    expect(args).toContain('--read-only');
    expect(args).toContain('/workspace/experiments');
    expect(args).toContain('--gpus');
    expect(args).toContain('all');
    expect(args).toContain('python:3.11-slim');
    expect(args.at(-2)).toBe('python');
    expect(args.at(-1)).toBe('run.py');
  });
});

describe('ssh runner argument construction', () => {
  it('builds ssh/scp arguments and a safe remote script', () => {
    const runner = new SSHRunner({ host: 'asus@127.0.0.1', port: 2222, identity: 'C:\\keys\\wsl_rsa', baseDir: '/home/asus/reprolens', enableGPU: true });
    const req = {
      projectId: 'proj_1', runId: 'run_1', workspace: '.', evidenceDir: '.', command: 'python run_experiment.py --seed 42', workDir: 'experiments/subdir', seed: 42, timeoutMs: 1000,
    };
    const script = runner.buildRunScript(req, '/home/asus/reprolens/proj_1/run_1');
    for (const expected of ['cd ', 'tar -xzf', 'REPROLENS_SEED=42', 'CUDA_VISIBLE_DEVICES=0', 'python run_experiment.py --seed 42', '/experiments/subdir']) expect(script).toContain(expected);
    expect(runner.buildSSHArgs('echo ok').join(' ')).toContain('-p 2222');
    expect(runner.buildSSHArgs('echo ok').join(' ')).toContain('asus@127.0.0.1');
    expect(runner.buildSCPArgs('local.tar.gz', '/home/asus/reprolens/workspace.tar.gz').join(' ')).toContain('-P 2222');

  });

  it('rejects option-injection hosts and escaping work directories', () => {
    expect(() => new SSHRunner({ host: '-oProxyCommand=calc.exe' })).toThrow(/invalid SSH host/);
    const runner = new SSHRunner({ host: 'asus@127.0.0.1' });
    const req = {
      projectId: 'proj_1', runId: 'run_1', workspace: '.', evidenceDir: '.', command: 'python run.py', workDir: '../outside', seed: 42, timeoutMs: 1000,
    };
    expect(() => runner.buildRunScript(req, '/home/asus/reprolens/proj_1/run_1')).toThrow(/escapes remote workspace/);
  });
});