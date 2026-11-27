import { describe, expect, it } from 'vitest';
import { extractMetric, verifyMetric, verifyRun } from '../src/tools/verify.js';

describe('rule-based verification', () => {
  it('extracts a metric from stdout using a regex', () => {
    const metric = extractMetric('epoch=3 accuracy=0.81\n', {
      kind: 'stdout_regex', pattern: '(?i)accuracy\\s*=\\s*([0-9.]+)',
    });
    expect(metric.value).toBe(0.81);
    expect(metric.name).toBe('accuracy');
  });

  it('computes PASS, DIFFERENT, and INSUFFICIENT_EVIDENCE', () => {
    expect(verifyMetric(0.81, 0.805, { abs: 0.01, rel: 0 })).toMatchObject({ verdict: 'PASS' });
    expect(verifyMetric(0.81, 0.5, { abs: 0.01, rel: 0 })).toMatchObject({ verdict: 'DIFFERENT' });
    expect(verifyMetric(Number.NaN, 0.5, { abs: 0.01, rel: 0 })).toMatchObject({ verdict: 'INSUFFICIENT_EVIDENCE' });
  });

  it('verifies a successful run and marks failed runs as FAILED', () => {
    const plan = {
      id: 'plan_c1', claim_id: 'C1', command: 'python run.py', image: 'python:3.11-slim', work_dir: '.', seed: 42,
      expected_metric: 'accuracy', expected_value: 0.81, tolerance: { abs: 0.01, rel: 0 }, metric_source: { kind: 'stdout_regex', pattern: 'accuracy=([0-9.]+)' }, confirmed: true,
    };
    const run = {
      run_id: 'run_1', attempt: 1, runner: 'local', command: plan.command, work_dir: '.', status: 'succeeded', exit_code: 0,
      started_at: new Date().toISOString(), finished_at: new Date().toISOString(), duration_ms: 1, stdout: 'accuracy=0.81\n',
    };
    expect(verifyRun(plan, run)).toMatchObject({ verdict: 'PASS', observed: 0.81 });
    expect(verifyRun(plan, { ...run, status: 'failed' })).toMatchObject({ verdict: 'FAILED' });
  });

  it('verifies compound all-of criteria with multiple metrics', () => {
    const plan = {
      id: 'plan_compound', claim_id: 'C2', command: 'python run.py', image: 'python:3.11-slim', work_dir: '.', seed: 42,
      expected_metric: 'accuracy+iterations', expected_value: 0.95, tolerance: { abs: 0, rel: 0 },
      metric_source: { kind: 'stdout_regex', pattern: 'accuracy=([0-9.]+)' }, confirmed: true,
      aggregation: 'all' as const,
      criteria: [
        { id: 'accuracy', metric: 'accuracy', operator: 'gte' as const, expected: 0.95, tolerance: { abs: 0, rel: 0 }, metric_source: { kind: 'stdout_regex', pattern: 'accuracy=([0-9.]+)' } },
        { id: 'iterations', metric: 'iterations', operator: 'between' as const, lower: 900, upper: 920, tolerance: { abs: 0, rel: 0 }, metric_source: { kind: 'stdout_regex', pattern: 'iterations=([0-9.]+)' } },
      ],
    };
    const run = {
      run_id: 'run_compound', attempt: 1, runner: 'local', command: plan.command, work_dir: '.', status: 'succeeded', exit_code: 0,
      started_at: new Date().toISOString(), finished_at: new Date().toISOString(), duration_ms: 1, stdout: 'accuracy=0.97\niterations=910\n',
    };
    const result = verifyRun(plan, run);
    expect(result.verdict).toBe('PASS');
    expect(result.criteria_results).toHaveLength(2);
    expect(result.criteria_results?.map((item) => item.metric)).toEqual(['accuracy', 'iterations']);
  });

  it('supports any-of aggregation and insufficient compound evidence', () => {
    const plan = {
      id: 'plan_any', claim_id: 'C3', command: 'python run.py', image: 'python:3.11-slim', work_dir: '.', seed: 42,
      expected_metric: 'accuracy+loss', expected_value: 0.95, tolerance: { abs: 0, rel: 0 },
      metric_source: { kind: 'stdout_regex', pattern: 'accuracy=([0-9.]+)' }, confirmed: true,
      aggregation: 'any' as const,
      criteria: [
        { id: 'accuracy', metric: 'accuracy', operator: 'gte' as const, expected: 0.95, tolerance: { abs: 0, rel: 0 }, metric_source: { kind: 'stdout_regex', pattern: 'accuracy=([0-9.]+)' } },
        { id: 'loss', metric: 'loss', operator: 'lte' as const, expected: 0.1, tolerance: { abs: 0, rel: 0 }, metric_source: { kind: 'stdout_regex', pattern: 'loss=([0-9.]+)' } },
      ],
    };
    const run = {
      run_id: 'run_any', attempt: 1, runner: 'local', command: plan.command, work_dir: '.', status: 'succeeded', exit_code: 0,
      started_at: new Date().toISOString(), finished_at: new Date().toISOString(), duration_ms: 1, stdout: 'accuracy=0.97\n',
    };
    expect(verifyRun(plan, run).verdict).toBe('PASS');
    expect(verifyRun({ ...plan, aggregation: 'all' }, run).verdict).toBe('INSUFFICIENT_EVIDENCE');
  });
  it('fails closed on nonzero exit codes, truncated output, and mismatched plan bindings', () => {
    const plan = {
      id: 'plan_bind', claim_id: 'C4', command: 'python run.py', image: 'python:3.11-slim', work_dir: '.', seed: 42,
      expected_metric: 'accuracy', expected_value: 0.81, tolerance: { abs: 0.01, rel: 0 }, metric_source: { kind: 'stdout_regex', pattern: 'accuracy=([0-9.]+)' }, confirmed: true,
    };
    const run = {
      run_id: 'run_bind', attempt: 1, runner: 'local', command: plan.command, work_dir: '.', status: 'succeeded', exit_code: 0,
      started_at: new Date().toISOString(), finished_at: new Date().toISOString(), duration_ms: 1, stdout: 'accuracy=0.81\n',
    };
    expect(verifyRun(plan, { ...run, exit_code: 1 }).verdict).toBe('FAILED');
    expect(verifyRun(plan, { ...run, stdout_truncated: true }).verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(verifyRun(plan, { ...run, plan_id: 'another-plan' }).verdict).toBe('FAILED');
    expect(verifyRun(plan, { ...run, claim_id: 'C9' }).verdict).toBe('FAILED');
  });});
