import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/memory-store.js';
import { HeuristicAnalyzer } from '../src/agent/heuristic.js';
import { LocalRunner } from '../src/tools/local-runner.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { materializeDemo } from '../src/demo.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function demoOrchestrator(): Promise<{ orchestrator: Orchestrator; dataDir: string; store: MemoryStore }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'reprolens-orch-'));
  dirs.push(dataDir);
  const store = new MemoryStore();
  return { orchestrator: new Orchestrator(store, new HeuristicAnalyzer(), new LocalRunner(), dataDir), dataDir, store };
}

describe('orchestrator', () => {
  it('runs the demo through failure, patch approval, and rule-computed PASS', async () => {
    const { orchestrator, dataDir } = await demoOrchestrator();
    const paths = await materializeDemo(dataDir, 'demo-project');
    const dataset = join(dataDir, 'dataset.csv');
    await writeFile(dataset, 'x,y\n0,1\n', 'utf8');
    let project = await orchestrator.createProject({ name: 'Accuracy demo', ...paths, dataPath: dataset, budget: { max_runs: 3, max_seconds: 30, max_patches: 2 } });
    expect(project.state).toBe('CREATED');
    project = await orchestrator.start(project.id);
    expect(project.state).toBe('AWAITING_CLAIMS');
    expect(await readFile(join(project.workspace_path, 'inputs', 'data', 'dataset.csv'), 'utf8')).toContain('0,1');
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

  it('recovers projects left active by a server restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'reprolens-recover-'));
    dirs.push(dataDir);
    const store = new MemoryStore();
    const now = new Date().toISOString();
    await store.createProject({
      id: 'recover_project', name: 'Interrupted', state: 'EXECUTING',
      paper_path: 'paper.pdf', repo_path: dataDir, workspace_path: dataDir, evidence_dir: dataDir,
      budget: { max_runs: 1, max_seconds: 10, max_patches: 0 },
      paper: { title: '', text: '', source_path: 'paper.pdf', sha256: '', claims: [], parsed_at: now },
      repo: { root: dataDir, files: [], command_candidates: [], scanned_at: now },
      created_at: now, updated_at: now,
    });
    const orchestrator = new Orchestrator(store, new HeuristicAnalyzer(), new LocalRunner(), dataDir);
    const recovered = await orchestrator.recoverInterruptedProjects();
    expect(recovered).toHaveLength(1);
    expect((await orchestrator.getProject('recover_project')).state).toBe('FAILED');
    const events = await orchestrator.events('recover_project');
    expect(events.some((event) => event.type === 'workflow_interrupted')).toBe(true);
  });

  it('replays a completed idempotent start operation', async () => {
    const { orchestrator, dataDir } = await demoOrchestrator();
    const paths = await materializeDemo(dataDir, 'idempotent-project');
    let project = await orchestrator.createProject({ name: 'Idempotent demo', ...paths, budget: { max_runs: 2, max_seconds: 20, max_patches: 1 } });
    const first = await orchestrator.start(project.id, 'start-key-1');
    const second = await orchestrator.start(project.id, 'start-key-1');
    expect(first.state).toBe('AWAITING_CLAIMS');
    expect(second.state).toBe('AWAITING_CLAIMS');
    const operations = await orchestrator.operations(project.id);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ kind: 'start', status: 'succeeded', idempotency_key: 'start-key-1' });
    project = await orchestrator.getProject(project.id);
    expect(project.revision).toBeGreaterThan(1);
  });

  it('marks running operations abandoned when recovering an interrupted server', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'reprolens-operation-recover-'));
    dirs.push(dataDir);
    const store = new MemoryStore();
    const now = new Date().toISOString();
    await store.createProject({
      id: 'operation_recover', name: 'Interrupted operation', state: 'EXECUTING',
      paper_path: 'paper.pdf', repo_path: dataDir, workspace_path: dataDir, evidence_dir: dataDir,
      budget: { max_runs: 1, max_seconds: 10, max_patches: 0 },
      paper: { title: '', text: '', source_path: 'paper.pdf', sha256: '', claims: [], parsed_at: now },
      repo: { root: dataDir, files: [], command_candidates: [], scanned_at: now },
      created_at: now, updated_at: now,
    });
    await store.createOperation({
      id: 'op_recover', project_id: 'operation_recover', kind: 'confirm_plan', status: 'running',
      lease_owner: 'dead-server', lease_expires_at: now, heartbeat_at: now, created_at: now, updated_at: now,
    });
    const orchestrator = new Orchestrator(store, new HeuristicAnalyzer(), new LocalRunner(), dataDir);
    await orchestrator.recoverInterruptedProjects();
    const operations = await orchestrator.operations('operation_recover');
    expect(operations[0]).toMatchObject({ status: 'abandoned' });
  });
  it('replays idempotent claim selection', async () => {
    const { orchestrator, dataDir } = await demoOrchestrator();
    const paths = await materializeDemo(dataDir, 'claim-idempotent');
    const project = await orchestrator.createProject({ name: 'Claim replay', ...paths, budget: { max_runs: 2, max_seconds: 20, max_patches: 1 } });
    await orchestrator.start(project.id, 'claim-start');
    const first = await orchestrator.selectClaims(project.id, ['C1'], 'claims-key');
    const second = await orchestrator.selectClaims(project.id, ['C1'], 'claims-key');
    expect(first.state).toBe('AWAITING_PLAN');
    expect(second.state).toBe('AWAITING_PLAN');
    const operations = await orchestrator.operations(project.id);
    expect(operations.filter((operation) => operation.kind === 'select_claims')).toHaveLength(1);
  });
  it('blocks selection when a claim quote does not exist in the paper', async () => {
    const { orchestrator, dataDir, store } = await demoOrchestrator();
    const paths = await materializeDemo(dataDir, 'provenance-project');
    const project = await orchestrator.createProject({ name: 'Provenance guard', ...paths, budget: { max_runs: 2, max_seconds: 20, max_patches: 1 } });
    await orchestrator.start(project.id, 'provenance-start');
    const stored = await store.getProject(project.id);
    stored.claims![0]!.source.quote = 'accuracy = 0.9999';
    stored.claims![0]!.source.provenance = 'mismatch';
    await store.saveProject(stored);
    await expect(orchestrator.selectClaims(project.id, ['C1'], 'provenance-claims')).rejects.toThrow(/provenance/i);
    expect((await orchestrator.getProject(project.id)).state).toBe('AWAITING_CLAIMS');
  });
  it('streams delegated code agent output into the event timeline', async () => {
    const { orchestrator, dataDir } = await demoOrchestrator();
    const analyzer = new (class extends HeuristicAnalyzer {
      override async diagnose() {
        return { failure_class: 'seed_mismatch', root_cause: 'seed mismatch', confidence: 'high', needs_code_agent: true };
      }
    })();
    orchestrator.setAnalyzer(analyzer);
    orchestrator.setCodeAgent({
      name: () => 'fake-code-agent',
      propose: async (task) => {
        task.onOutput?.('stdout', 'delegated output: inspecting seed\n');
        return {
          agent: 'fake-code-agent', version: '1.0.0',
          diff: [
            'diff --git a/run_experiment.py b/run_experiment.py',
            '--- a/run_experiment.py',
            '+++ b/run_experiment.py',
            '@@ -3,5 +3,5 @@',
            ' # Intentional bug for the ReproLens demo: the paper requires seed 42.',
            '-SEED = 0',
            '+SEED = 42',
            ' ',
            ' parser = argparse.ArgumentParser()',
            '',
          ].join('\n'),
          files: ['run_experiment.py'], summary: 'fixed seed', stdout: 'delegated output: inspecting seed\n', stderr: '',
          logPath: join(dataDir, 'fake-code-agent.log'), durationMs: 12,
        };
      },
    });
    const paths = await materializeDemo(dataDir, 'codeagent-stream-project');
    let project = await orchestrator.createProject({ name: 'Code agent stream', ...paths, budget: { max_runs: 2, max_seconds: 20, max_patches: 1 } });
    project = await orchestrator.start(project.id, 'codeagent-start');
    project = await orchestrator.selectClaims(project.id, ['C1'], 'codeagent-claims');
    project = await orchestrator.confirmPlan(project.id, 'codeagent-confirm');
    expect(project.state).toBe('AWAITING_PATCH');
    const events = await orchestrator.events(project.id);
    expect(events.some((event) => event.type === 'code_agent_started')).toBe(true);
    expect(events.some((event) => event.type === 'code_agent_output' && event.message.includes('inspecting seed'))).toBe(true);
    expect(events.some((event) => event.type === 'code_agent_proposed')).toBe(true);
  });
  it('reads every event beyond the first 1,000 rows', async () => {
    const { orchestrator, dataDir, store } = await demoOrchestrator();
    const paths = await materializeDemo(dataDir, 'event-page-project');
    const project = await orchestrator.createProject({ name: 'Event paging', ...paths, budget: { max_runs: 1, max_seconds: 10, max_patches: 0 } });
    for (let index = 0; index < 1005; index += 1) {
      await store.appendEvent(project.id, 'test_event', `event ${index}`);
    }
    const events = await orchestrator.allEvents(project.id);
    expect(events.length).toBeGreaterThan(1000);
    expect(events.at(-1)?.message).toBe('event 1004');
  });});