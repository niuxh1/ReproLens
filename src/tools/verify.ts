import type {
  CriterionResult, ExperimentPlan, Metric, MetricSource, Run, Tolerance, Verification, VerificationCriterion, Verdict,
} from '../domain/types.js';

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
    rule_version: 2,
    verified_at: new Date().toISOString(),
  };
  if (run.status !== 'succeeded') {
    return { ...base, verdict: 'FAILED', note: 'the experiment did not complete successfully' };
  }
  if (run.exit_code !== 0) {
    return { ...base, verdict: 'FAILED', note: `the experiment exited with code ${run.exit_code}` };
  }
  if (run.plan_id && run.plan_id !== plan.id) {
    return { ...base, verdict: 'FAILED', note: `run is bound to plan ${run.plan_id}, expected ${plan.id}` };
  }
  if (run.claim_id && run.claim_id !== plan.claim_id) {
    return { ...base, verdict: 'FAILED', note: `run is bound to claim ${run.claim_id}, expected ${plan.claim_id}` };
  }
  if (run.stdout_truncated) {
    return { ...base, verdict: 'INSUFFICIENT_EVIDENCE', note: 'stdout was truncated before verification' };
  }
  if (plan.criteria?.length) {
    const results = plan.criteria.map((criterion) => verifyCriterion(criterion, run.stdout ?? ''));
    const aggregate = aggregateCriteria(results, plan.aggregation ?? 'all');
    const representative = results.find((result) => result.observed !== undefined) ?? results[0];
    return {
      ...base,
      metric: plan.expected_metric || plan.criteria.map((criterion) => criterion.metric).join('+'),
      expected: representative?.expected ?? representative?.lower ?? plan.expected_value,
      observed: representative?.observed ?? 0,
      tolerance: representative ? (plan.criteria.find((criterion) => criterion.id === representative.criterion_id)?.tolerance ?? plan.tolerance) : plan.tolerance,
      verdict: aggregate.verdict,
      rule: aggregate.rule,
      criteria_results: results,
      ...(run.stdout_path ? { evidence: [run.stdout_path] } : {}),
    };
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

export function verifyCriterion(criterion: VerificationCriterion, stdout: string): CriterionResult {
  const result: CriterionResult = {
    criterion_id: criterion.id,
    metric: criterion.metric,
    operator: criterion.operator,
    ...(criterion.expected !== undefined ? { expected: criterion.expected } : {}),
    ...(criterion.lower !== undefined ? { lower: criterion.lower } : {}),
    ...(criterion.upper !== undefined ? { upper: criterion.upper } : {}),
    verdict: 'INSUFFICIENT_EVIDENCE',
    rule: '',
  };
  let observed: number;
  try {
    observed = extractMetric(stdout, criterion.metric_source).value;
  } catch (error) {
    return { ...result, rule: (error as Error).message };
  }
  result.observed = observed;
  const verdict = evaluateOperator(criterion, observed);
  return { ...result, ...verdict };
}

function evaluateOperator(criterion: VerificationCriterion, observed: number): { verdict: Verdict; rule: string } {
  if (criterion.operator === 'eq') {
    if (criterion.expected === undefined || !Number.isFinite(criterion.expected)) return { verdict: 'INSUFFICIENT_EVIDENCE', rule: 'eq criterion has no finite expected value' };
    return verifyMetric(criterion.expected, observed, criterion.tolerance);
  }
  if (criterion.operator === 'neq') {
    if (criterion.expected === undefined || !Number.isFinite(criterion.expected)) return { verdict: 'INSUFFICIENT_EVIDENCE', rule: 'neq criterion has no finite expected value' };
    const equality = verifyMetric(criterion.expected, observed, criterion.tolerance);
    return equality.verdict === 'PASS'
      ? { verdict: 'DIFFERENT', rule: `observed ${observed} is within the excluded equality tolerance` }
      : { verdict: 'PASS', rule: `observed ${observed} differs from excluded value ${criterion.expected}` };
  }
  if (criterion.operator === 'between') {
    if (criterion.lower === undefined || criterion.upper === undefined || !Number.isFinite(criterion.lower) || !Number.isFinite(criterion.upper)) {
      return { verdict: 'INSUFFICIENT_EVIDENCE', rule: 'between criterion requires finite lower and upper bounds' };
    }
    if (criterion.lower > criterion.upper) return { verdict: 'INSUFFICIENT_EVIDENCE', rule: 'between lower bound exceeds upper bound' };
    return observed >= criterion.lower && observed <= criterion.upper
      ? { verdict: 'PASS', rule: `${observed} is within [${criterion.lower}, ${criterion.upper}]` }
      : { verdict: 'DIFFERENT', rule: `${observed} is outside [${criterion.lower}, ${criterion.upper}]` };
  }
  if (criterion.expected === undefined || !Number.isFinite(criterion.expected)) {
    return { verdict: 'INSUFFICIENT_EVIDENCE', rule: `${criterion.operator} criterion has no finite expected value` };
  }
  const comparisons = {
    gt: { pass: observed > criterion.expected, rule: `${observed} > ${criterion.expected}` },
    gte: { pass: observed >= criterion.expected, rule: `${observed} >= ${criterion.expected}` },
    lt: { pass: observed < criterion.expected, rule: `${observed} < ${criterion.expected}` },
    lte: { pass: observed <= criterion.expected, rule: `${observed} <= ${criterion.expected}` },
  };
  const comparison = comparisons[criterion.operator];
  return comparison.pass
    ? { verdict: 'PASS', rule: comparison.rule }
    : { verdict: 'DIFFERENT', rule: comparison.rule.replace(' ', ' not ').replace('not >=', '<').replace('not <=', '>').replace('not >', '<=').replace('not <', '>=') };
}

export function aggregateCriteria(results: CriterionResult[], mode: 'all' | 'any'): { verdict: Verdict; rule: string } {
  if (results.length === 0) return { verdict: 'INSUFFICIENT_EVIDENCE', rule: 'no verification criteria were provided' };
  if (results.some((result) => result.verdict === 'FAILED')) return { verdict: 'FAILED', rule: 'at least one criterion failed' };
  if (mode === 'any') {
    if (results.some((result) => result.verdict === 'PASS')) return { verdict: 'PASS', rule: 'any-of: at least one criterion passed' };
    if (results.some((result) => result.verdict === 'INSUFFICIENT_EVIDENCE')) return { verdict: 'INSUFFICIENT_EVIDENCE', rule: 'any-of: no criterion passed and evidence is incomplete' };
    return { verdict: 'DIFFERENT', rule: 'any-of: all criteria differed' };
  }
  if (results.some((result) => result.verdict === 'INSUFFICIENT_EVIDENCE')) return { verdict: 'INSUFFICIENT_EVIDENCE', rule: 'all-of: at least one criterion has insufficient evidence' };
  if (results.some((result) => result.verdict === 'DIFFERENT')) return { verdict: 'DIFFERENT', rule: 'all-of: at least one criterion differed' };
  return { verdict: 'PASS', rule: 'all-of: every criterion passed' };
}

function inferMetricName(pattern: string): string {
  const known = /(accuracy|f1|auc|precision|recall|loss|mae|rmse|rouge|bleu)/i.exec(pattern);
  return known ? known[1]!.toLowerCase() : 'metric';
}