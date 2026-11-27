import { describe, expect, it } from 'vitest';
import { aggregateVerdict, assessReproducibility } from '../src/tools/assessment.js';
import type { Event, Project } from '../src/domain/types.js';

function project(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: 'p_score', name: 'Score project', state: 'COMPLETED',
    paper_path: '/paper.pdf', repo_path: '/repo', workspace_path: '/workspace', evidence_dir: '/evidence',
    budget: { max_runs: 3, max_seconds: 120, max_patches: 2 },
    paper: {
      title: 'Paper', text: 'accuracy 0.9', source_path: '/paper.pdf', sha256: 'abc', claims: [], parsed_at: now,
      pages: [{ page_number: 1, text: '', image_path: '/evidence/page-001.png', caption_candidates: [] }],
    },
    repo: { root: '/repo', files: [], command_candidates: [], scanned_at: now },
    claims: [{ claim_id: 'C1', text: 'accuracy 0.9', metric: 'accuracy', expected_value: 0.9, tolerance: { abs: 0.01, rel: 0 }, source: { path: '/paper.pdf', line: 1 }, selected: true }],
    runs: [{
      run_id: 'r1', attempt: 1, runner: 'local', command: 'python run.py', work_dir: '.', status: 'succeeded', exit_code: 0,
      started_at: now, finished_at: now, duration_ms: 1000, gpu: false, metric: { name: 'accuracy', value: 0.9 },
      stdout_path: '/evidence/stdout.log', stderr_path: '/evidence/stderr.log',
    }],
    verification: { verification_id: 'v1', claim_id: 'C1', metric: 'accuracy', expected: 0.9, observed: 0.9, tolerance: { abs: 0.01, rel: 0 }, verdict: 'PASS', rule: 'abs_error 0 <= 0.01', verified_at: now },
    created_at: now, updated_at: now,
    ...overrides,
  };
}

describe('reproducibility assessment', () => {
  it('scores a single local successful run as a transparent B grade without changing verdict', () => {
    const events: Event[] = [{ id: 1, project_id: 'p_score', seq: 1, type: 'metric_verified', message: 'PASS', created_at: new Date().toISOString() }];
    const assessment = assessReproducibility(project(), events);
    expect(assessment.score).toBe(60);
    expect(assessment.grade).toBe('C');
    expect(assessment.caps).toContain('单次成功运行最高 60 分');
    expect(assessment.verdict).toBe('PASS');
    expect(assessment.policy_version).toBe(1);
    expect(assessment.factors).toHaveLength(6);
    expect(assessment.factors.find((factor) => factor.id === 'isolation')?.score).toBe(3);
    expect(assessment.factors.find((factor) => factor.id === 'repeatability')?.detail).toContain('1');
  });

  it('aggregates multiple claim verdicts with the strictest result', () => {
    const base = project();
    const second = { ...base.verification!, verification_id: 'v2', claim_id: 'C2', verdict: 'DIFFERENT' as const, observed: 0.7 };
    const assessment = assessReproducibility(project({ verification: second, verifications: [base.verification!, second] }), []);
    expect(assessment.verdict).toBe('DIFFERENT');
  });

  it('rewards repeated Docker runs and complete evidence with an A grade', () => {
    const base = project();
    const second = { ...base.runs![0]!, run_id: 'r2', attempt: 2, runner: 'docker', gpu: true, metric: { name: 'accuracy', value: 0.901 } };
    const events: Event[] = [1, 2].map((seq) => ({ id: seq, project_id: base.id, seq, type: 'metric_verified', message: 'PASS', created_at: new Date().toISOString() }));
    const assessment = assessReproducibility(project({ runs: [{ ...base.runs![0]!, runner: 'docker', gpu: true }, second] }), events);
    expect(assessment.score).toBe(100);
    expect(assessment.grade).toBe('A');
  });

  it('requires verification coverage for every selected claim', () => {
    const base = project();
    const result = aggregateVerdict([base.verification!], ['C1', 'C2']);
    expect(result).toMatchObject({
      verdict: 'INSUFFICIENT_EVIDENCE',
      expected_count: 2,
      verified_count: 1,
      missing_claim_ids: ['C2'],
    });
  });

  it('ignores verification for unselected claims during aggregation', () => {
    const base = project();
    const extra = { ...base.verification!, verification_id: 'v_extra', claim_id: 'C9', verdict: 'DIFFERENT' as const };
    const result = aggregateVerdict([base.verification!, extra], ['C1']);
    expect(result).toMatchObject({ verdict: 'PASS', expected_count: 1, verified_count: 1, missing_claim_ids: [] });
  });});