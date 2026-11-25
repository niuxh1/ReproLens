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
});
