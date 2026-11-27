import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandAgent, inspectCommand } from '../src/codeagent/command.js';
import { Workspace } from '../src/tools/workspace.js';
import { PatchManager } from '../src/tools/patch.js';
import type { CodeAgentTask } from '../src/codeagent/code-agent.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('command code agent', () => {
  it('inspects whether a configured executable exists without running it', async () => {
    await expect(inspectCommand('node')).resolves.toMatchObject({ available: true, executable: 'node' });
    expect((await inspectCommand('node')).version).toMatch(/^v?\d+/);
    await expect(inspectCommand('reprolens-definitely-missing-cli')).resolves.toMatchObject({ available: false });
  });

  it('works in an isolated copy and returns a git-compatible diff', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reprolens-codeagent-'));
    dirs.push(dir);
    const ws = await Workspace.create(dir, 'codeagent_project');
    await writeFile(join(ws.root, 'run.py'), "print('accuracy=0.50')\n");
    await writeFile(join(ws.root, 'fake_agent.py'), [
      'from pathlib import Path',
      'import sys',
      'Path("run.py").write_text("print(\'accuracy=0.81\')\\n")',
      'Path("implementation.py").write_text("def solve():\\n    return 42\\n")',
      'print("prompt_received=" + str(len(sys.argv) > 1))',
    ].join('\n'));
    const agent = new CommandAgent({ command: 'python fake_agent.py', appendPrompt: true, timeoutMs: 20_000 });
    const task: CodeAgentTask = {
      projectId: 'codeagent_project', claimId: 'C1', workspace: ws.root, evidenceDir: ws.evidenceDir,
      acceptanceCommand: 'python run.py',
      paper: { title: 'demo', text: 'accuracy 0.81', source_path: 'paper.md', sha256: 'x', claims: [], parsed_at: new Date().toISOString() },
      claim: { claim_id: 'C1', text: 'accuracy 0.81', metric: 'accuracy', expected_value: 0.81, tolerance: { abs: 0.01, rel: 0 }, source: { path: 'paper.md', line: 1 }, selected: true },
      plan: { id: 'plan_c1', claim_id: 'C1', command: 'python run.py', image: 'python:3.11-slim', work_dir: '.', seed: 42, expected_metric: 'accuracy', expected_value: 0.81, tolerance: { abs: 0.01, rel: 0 }, metric_source: { kind: 'stdout_regex', pattern: 'accuracy=([0-9.]+)' }, confirmed: true },
      run: { run_id: 'run_1', attempt: 1, runner: 'local', command: 'python run.py', work_dir: '.', status: 'failed', exit_code: 1, started_at: new Date().toISOString(), finished_at: new Date().toISOString(), duration_ms: 1, stderr: 'missing implementation' },
      diagnosis: { failure_class: 'missing_implementation', root_cause: 'missing', confidence: 'high', needs_code_agent: true },
    };
    const streamed: string[] = [];
    const result = await agent.propose({ ...task, onOutput: (_stream, text) => streamed.push(text) });
    expect(streamed.join('')).toContain('prompt_received=');
    expect(result.diff).toContain("+print('accuracy=0.81')");
    expect(result.diff).toContain('+def solve():');
    expect(result.files.sort()).toEqual(['implementation.py', 'run.py']);
    expect(result.logPath).toBeTruthy();
    expect((await stat(result.logPath!)).isFile()).toBe(true);
    expect(await readFile(join(ws.root, 'run.py'), 'utf8')).toBe("print('accuracy=0.50')\n");
    const applied = await new PatchManager(ws.root).apply(result.diff);
    expect(applied.sort()).toEqual(['implementation.py', 'run.py']);
    expect(await readFile(join(ws.root, 'implementation.py'), 'utf8')).toContain('return 42');
  });
});
