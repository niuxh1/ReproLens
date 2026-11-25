import { describe, expect, it } from 'vitest';
import { HeuristicAnalyzer } from '../src/agent/heuristic.js';
import type { Event, Project } from '../src/domain/types.js';

describe('main agent report summary', () => {
  it('writes a grounded Chinese summary without changing the rule verdict', async () => {
    const now = new Date().toISOString();
    const project: Project = {
      id: 'p_summary', name: 'Grokfast reproduction', state: 'COMPLETED',
      paper_path: '/papers/grokfast.pdf', repo_path: '/repos/grokfast', workspace_path: '/workspace', evidence_dir: '/evidence',
      budget: { max_runs: 3, max_seconds: 120, max_patches: 2 },
      paper: { title: 'Grokfast', text: '', source_path: '/papers/grokfast.pdf', sha256: 'abc', claims: [], parsed_at: now, pages: [{ page_number: 1, text: '', image_path: '/evidence/page-001.png', caption_candidates: [] }] },
      repo: { root: '/repos/grokfast', files: [], command_candidates: [], scanned_at: now },
      claims: [{ claim_id: 'C1', text: 'The method reaches 910 iterations.', metric: 'iterations', expected_value: 910, tolerance: { abs: 300, rel: 0 }, source: { path: '/papers/grokfast.pdf', line: 8 }, selected: true }],
      plans: [{ id: 'plan_c1', claim_id: 'C1', command: 'python train.py', image: 'python:3.11-slim', work_dir: '.', seed: 42, expected_metric: 'iterations', expected_value: 910, tolerance: { abs: 300, rel: 0 }, metric_source: { kind: 'stdout_regex', pattern: 'iterations=(\\d+)' }, confirmed: true }],
      runs: [{ run_id: 'r1', attempt: 1, runner: 'local', command: 'python train.py', work_dir: '.', status: 'succeeded', exit_code: 0, started_at: now, finished_at: now, duration_ms: 4200, gpu: true, metric: { name: 'iterations', value: 900 } }],
      verification: { verification_id: 'v1', claim_id: 'C1', metric: 'iterations', expected: 910, observed: 900, tolerance: { abs: 300, rel: 0 }, verdict: 'PASS', rule: 'abs_error 10 <= 300', verified_at: now },
      created_at: now, updated_at: now,
    };
    const events: Event[] = [{ id: 1, project_id: project.id, seq: 1, type: 'metric_verified', message: 'rule-based verdict PASS', created_at: now }];
    const summary = await new HeuristicAnalyzer().summarizeReport(project, events);
    expect(summary.source).toBe('heuristic');
    expect(summary.model).toBe('deterministic-heuristic');
    expect(summary.markdown).toContain('主 Agent 总结');
    expect(summary.markdown).toContain('910');
    expect(summary.markdown).toContain('900');
    expect(summary.markdown).toContain('PASS');
    expect(summary.markdown).toContain('限制');
    expect(summary.verdict).toBe('PASS');
  });
});