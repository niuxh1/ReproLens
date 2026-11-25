import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memory-store.js';
import { HeuristicAnalyzer } from '../src/agent/heuristic.js';
import { LocalRunner } from '../src/tools/local-runner.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { materializeDemo } from '../src/demo.js';

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function demoOrchestrator(): Promise<{ orchestrator: Orchestrator; dataDir: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'reprolens-orch-'));
  dirs.push(dataDir);
  const store = new MemoryStore();
  return { orchestrator: new Orchestrator(store, new HeuristicAnalyzer(), new LocalRunner(), dataDir), dataDir };
}

describe('orchestrator', () => {
  it('runs the demo through failure, patch approval, and rule-computed PASS', async () => {
    const { orchestrator, dataDir } = await demoOrchestrator();
    const paths = await materializeDemo(dataDir, 'demo-project');
    let project = await orchestrator.createProject({ name: 'Accuracy demo', ...paths, budget: { max_runs: 3, max_seconds: 30, max_patches: 2 } });
    expect(project.state).toBe('CREATED');
    project = await orchestrator.start(project.id);
    expect(project.state).toBe('AWAITING_CLAIMS');
    expect(project.claims?.[0]?.claim_id).toBe('C1');
    project = await orchestrator.selectClaims(project.id, ['C1']);
    expect(project.state).toBe('AWAITING_PLAN');
    project = await orchestrator.confirmPlan(project.id);
    expect(project.state).toBe('AWAITING_PATCH');
    expect(project.patch?.diff).toContain('+SEED = 42');
    project = await orchestrator.approvePatch(project.id, 'test-user');
    expect(project.state).toBe('COMPLETED');
    expect(project.verification?.verdict).toBe('PASS');
    expect(project.report?.package_path).toBeTruthy();
    const events = await orchestrator.events(project.id);
    expect(events.some((event) => event.type === 'patch_approved')).toBe(true);
    expect(events.some((event) => event.type === 'report_generated')).toBe(true);
  });

});
