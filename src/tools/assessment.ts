import type { Event, Project, ReproducibilityAssessment, ReproducibilityFactor, ReproducibilityGrade, Verification, Verdict } from '../domain/types.js';

export function assessReproducibility(project: Project, events: Event[] = []): ReproducibilityAssessment {
  const successfulRuns = (project.runs ?? []).filter((run) => run.status === 'succeeded');
  const failedRuns = (project.runs ?? []).filter((run) => run.status !== 'succeeded');
  const verifications = project.verifications?.length ? project.verifications : project.verification ? [project.verification] : [];
  const selectedClaimIds = project.selected_claim_ids?.length ? project.selected_claim_ids : undefined;
  const aggregate = aggregateVerdict(verifications, selectedClaimIds);
  const verdict = aggregate?.verdict;

  const verdictScore = verdict === 'PASS' ? 30 : verdict === 'DIFFERENT' ? 18 : verdict === 'INSUFFICIENT_EVIDENCE' ? 8 : 0;
  const executionScore = successfulRuns.length > 0 ? 20 : failedRuns.length > 0 ? 6 : 0;
  const evidenceScore = evidenceCompleteness(project);
  const repeatabilityScore = repeatability(project, successfulRuns);
  const isolationScore = isolation(successfulRuns);
  const auditabilityScore = auditability(project, events);

  const factors: ReproducibilityFactor[] = [
    factor('verdict', '规则核验', verdictScore, 30, verdict ? `聚合 verdict：${verdict}` : '尚无规则核验结论'),
    factor('execution', '成功执行', executionScore, 20, successfulRuns.length ? `${successfulRuns.length} 次成功运行` : failedRuns.length ? '仅有失败运行' : '尚无运行记录'),
    factor('evidence', '证据完整性', evidenceScore, 15, evidenceDetail(project)),
    factor('repeatability', '重复性', repeatabilityScore, 15, repeatabilityDetail(successfulRuns)),
    factor('isolation', '环境隔离', isolationScore, 10, isolationDetail(successfulRuns)),
    factor('auditability', '审计完整性', auditabilityScore, 10, auditabilityDetail(project, events)),
  ];
  let score = factors.reduce((total, item) => total + item.score, 0);
  const caps: string[] = [];
  if (successfulRuns.length === 0) {
    score = Math.min(score, 20);
    caps.push('无成功运行最高 20 分');
  } else if (successfulRuns.length === 1) {
    score = Math.min(score, 60);
    caps.push('单次成功运行最高 60 分');
  }
  if (successfulRuns.length > 0 && isolationScore === 3) {
    score = Math.min(score, 65);
    caps.push('本机执行最高 65 分');
  }
  if (verifications.length === 0) {
    score = Math.min(score, 50);
    caps.push('无规则核验最高 50 分');
  }
  return {
    score,
    grade: gradeFor(score),
    ...(verdict ? { verdict } : {}),
    factors,
    caps,
    generated_at: new Date().toISOString(),
    policy_version: 1,
  };
}

function evidenceCompleteness(project: Project): number {
  let score = 0;
  if (project.paper.sha256) score += 3;
  if ((project.paper.pages ?? []).some((page) => Boolean(page.image_path))) score += 4;
  const latest = [...(project.runs ?? [])].reverse().find((run) => run.status === 'succeeded') ?? project.runs?.[project.runs.length - 1];
  if (latest?.stdout_path) score += 4;
  if (latest?.stderr_path) score += 4;
  return score;
}

function evidenceDetail(project: Project): string {
  const parts: string[] = [];
  if (project.paper.sha256) parts.push('论文哈希');
  if ((project.paper.pages ?? []).some((page) => Boolean(page.image_path))) parts.push('页面图像');
  const latest = [...(project.runs ?? [])].reverse().find((run) => run.status === 'succeeded') ?? project.runs?.[project.runs.length - 1];
  if (latest?.stdout_path) parts.push('stdout');
  if (latest?.stderr_path) parts.push('stderr');
  return parts.length ? parts.join(' / ') : '缺少可审计证据';
}

function repeatability(project: Project, successfulRuns: NonNullable<Project['runs']>): number {
  if (successfulRuns.length === 0) return 0;
  if (successfulRuns.length === 1) return 8;
  const values = successfulRuns.map((run) => run.metric?.value).filter((value): value is number => Number.isFinite(value));
  if (values.length < 2) return 10;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const tolerance = project.verification?.tolerance.abs ?? 0;
  return max - min <= tolerance ? 15 : 10;
}

function repeatabilityDetail(successfulRuns: NonNullable<Project['runs']>): string {
  if (successfulRuns.length === 0) return '尚无成功运行';
  if (successfulRuns.length === 1) return '1 次成功运行，尚未验证跨运行稳定性';
  return `${successfulRuns.length} 次成功运行`;
}

function isolation(successfulRuns: NonNullable<Project['runs']>): number {
  if (successfulRuns.length === 0) return 0;
  return successfulRuns.every((run) => run.runner === 'docker' || run.runner.startsWith('ssh')) ? 10 : 3;
}

function isolationDetail(successfulRuns: NonNullable<Project['runs']>): string {
  if (successfulRuns.length === 0) return '尚无成功运行';
  return successfulRuns.every((run) => run.runner === 'docker' || run.runner.startsWith('ssh'))
    ? 'Docker / SSH 隔离执行'
    : '本机执行，隔离等级较低';
}

function auditability(project: Project, events: Event[]): number {
  let score = 0;
  if (project.verifications?.length || project.verification) score += 5;
  if (events.length > 0) score += 3;
  if (!project.patch || project.patch.status === 'approved' || project.patch.status === 'applied') score += 2;
  else if (project.patch.status === 'proposed') score += 1;
  return score;
}

function auditabilityDetail(project: Project, events: Event[]): string {
  const parts: string[] = [];
  if (project.verifications?.length || project.verification) parts.push('规则快照');
  if (events.length > 0) parts.push(`${events.length} 条事件`);
  if (!project.patch) parts.push('无未审批补丁');
  else if (project.patch.status === 'approved' || project.patch.status === 'applied') parts.push('补丁已审批');
  else parts.push(`补丁状态：${project.patch.status}`);
  return parts.join(' / ');
}

export interface AggregateVerdictResult {
  verdict: Verdict;
  rule: string;
  expected_count: number;
  verified_count: number;
  missing_claim_ids: string[];
  extra_claim_ids: string[];
}

export function aggregateVerdict(verifications: Verification[], selectedClaimIds?: string[]): AggregateVerdictResult | null {
  const expectedIds = [...new Set((selectedClaimIds?.length ? selectedClaimIds : verifications.map((item) => item.claim_id)).filter(Boolean))];
  if (expectedIds.length === 0) return null;
  const expectedSet = new Set(expectedIds);
  const eligible = selectedClaimIds ? verifications.filter((item) => expectedSet.has(item.claim_id)) : verifications;
  const verifiedIds = [...new Set(eligible.map((item) => item.claim_id))];
  const missing = expectedIds.filter((id) => !verifiedIds.includes(id));
  const extra = verifiedIds.filter((id) => !expectedSet.has(id));
  const verdicts = new Set(eligible.map((item) => item.verdict));
  if (missing.length) verdicts.add('INSUFFICIENT_EVIDENCE');
  const verdict: Verdict = verdicts.has('FAILED')
    ? 'FAILED'
    : verdicts.has('DIFFERENT')
      ? 'DIFFERENT'
      : verdicts.has('INSUFFICIENT_EVIDENCE')
        ? 'INSUFFICIENT_EVIDENCE'
        : 'PASS';
  const coverage = `覆盖 ${verifiedIds.length}/${expectedIds.length} 条选中主张${missing.length ? `；缺少 ${missing.join(', ')}` : ''}`;
  return {
    verdict,
    rule: `FAILED > DIFFERENT > INSUFFICIENT_EVIDENCE > PASS；${coverage}；只有全部选中主张 PASS 才聚合为 PASS`,
    expected_count: expectedIds.length,
    verified_count: verifiedIds.length,
    missing_claim_ids: missing,
    extra_claim_ids: extra,
  };
}

function factor(id: string, label: string, score: number, max: number, detail: string): ReproducibilityFactor {
  const ratio = max > 0 ? score / max : 0;
  return { id, label, score, max, status: ratio >= 0.8 ? 'pass' : ratio >= 0.4 ? 'warn' : 'fail', detail };
}

function gradeFor(score: number): ReproducibilityGrade {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  return 'D';
}