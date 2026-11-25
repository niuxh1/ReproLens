import type { ExperimentPlan, Metric, MetricSource, Run, Tolerance, Verification, Verdict } from '../domain/types.js';

function compileRegex(pattern: string): RegExp {
  const inline = /^\(\?([ims]+)\)/.exec(pattern);
  if (inline) {
    const flags = inline[1]!.replace(/m/g, 'm').replace(/s/g, 's').replace(/i/g, 'i');
    return new RegExp(pattern.slice(inline[0].length), flags);
  }
  return new RegExp(pattern);
}

export function extractMetric(stdout: string, source: MetricSource): Metric {
  if (source.kind && source.kind !== 'stdout_regex') throw new Error(`unsupported metric source kind ${JSON.stringify(source.kind)}`);
  if (!source.pattern) throw new Error('metric regex is empty');
  let regex: RegExp;
  try {
    regex = compileRegex(source.pattern);
  } catch (error) {
    throw new Error(`compile metric regex: ${(error as Error).message}`);
  }
  const match = regex.exec(stdout);
  if (!match) throw new Error('metric not found in stdout');
  const raw = match[1] && match[1].trim() ? match[1].trim() : match[0].trim();
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`parse metric ${JSON.stringify(raw)}`);
  const name = source.key || inferMetricName(source.pattern);
  return { name, value, raw };
}

export function verifyMetric(expected: number, observed: number, tolerance: Tolerance): { verdict: Verdict; rule: string } {
  if (!Number.isFinite(expected) || !Number.isFinite(observed)) {
    return { verdict: 'INSUFFICIENT_EVIDENCE', rule: 'non-finite values cannot be verified' };
  }
  if (tolerance.abs < 0 || tolerance.rel < 0) {
    return { verdict: 'INSUFFICIENT_EVIDENCE', rule: 'negative tolerance is invalid' };
  }
  const diff = Math.abs(observed - expected);
  if (tolerance.abs === 0 && tolerance.rel === 0) {
    return diff === 0 ? { verdict: 'PASS', rule: 'exact equality' } : { verdict: 'DIFFERENT', rule: 'exact equality failed' };
  }
  if (tolerance.abs > 0 && diff <= tolerance.abs) {
    return { verdict: 'PASS', rule: `abs_error ${diff.toPrecision(8)} <= ${tolerance.abs.toPrecision(8)}` };
  }
  if (tolerance.rel > 0 && expected !== 0 && diff / Math.abs(expected) <= tolerance.rel) {
    return { verdict: 'PASS', rule: `rel_error ${(diff / Math.abs(expected)).toPrecision(8)} <= ${tolerance.rel.toPrecision(8)}` };
  }
  const parts: string[] = [];
  if (tolerance.abs > 0) parts.push(`abs_error ${diff.toPrecision(8)} > ${tolerance.abs.toPrecision(8)}`);
  if (tolerance.rel > 0) {
    const rel = expected === 0 ? Infinity : diff / Math.abs(expected);
    parts.push(`rel_error ${rel.toPrecision(8)} > ${tolerance.rel.toPrecision(8)}`);
  }
  return { verdict: 'DIFFERENT', rule: parts.join('; ') };
}

export function verifyRun(plan: ExperimentPlan, run: Run): Verification {
  const base: Verification = {
    verification_id: `verify_${run.run_id}`,
    claim_id: plan.claim_id,
    metric: plan.expected_metric,
    expected: plan.expected_value,
    observed: 0,
    tolerance: plan.tolerance,
    verdict: 'INSUFFICIENT_EVIDENCE',
    rule: '',
    verified_at: new Date().toISOString(),
  };
  if (run.status !== 'succeeded') {
    return { ...base, verdict: 'FAILED', note: 'the experiment did not complete successfully' };
  }
  try {
    const metric = extractMetric(run.stdout ?? '', plan.metric_source);
    const result = verifyMetric(plan.expected_value, metric.value, plan.tolerance);
    return {
      ...base,
      observed: metric.value,
      verdict: result.verdict,
      rule: result.rule,
      ...(run.stdout_path ? { evidence: [run.stdout_path] } : {}),
    };
  } catch (error) {
    return { ...base, note: (error as Error).message };
  }
}

function inferMetricName(pattern: string): string {
  const known = /(accuracy|f1|auc|precision|recall|loss|mae|rmse|rouge|bleu)/i.exec(pattern);
  return known ? known[1]!.toLowerCase() : 'metric';
}
