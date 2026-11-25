import AdmZip from 'adm-zip';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import type { AgentReportSummary, Event, EvidenceRef, Project, Report, Verdict } from '../domain/types.js';

const VERDICT_LABELS: Record<Verdict, string> = {
  PASS: '通过（PASS）',
  DIFFERENT: '存在差异（DIFFERENT）',
  INSUFFICIENT_EVIDENCE: '证据不足（INSUFFICIENT_EVIDENCE）',
  FAILED: '失败（FAILED）',
};

export async function buildReport(project: Project, events: Event[], agentSummary?: AgentReportSummary): Promise<Report> {
  const now = new Date().toISOString();
  const summary = project.verification
    ? `规则核验结果：${VERDICT_LABELS[project.verification.verdict]}。论文期望 ${formatNumber(project.verification.expected)}，实验观测 ${formatNumber(project.verification.observed)}，指标为 ${project.verification.metric}。`
    : '该项目尚未产生规则核验结论。';
  const report: Report = {
    report_id: `report_${project.id}`,
    generated_at: now,
    summary,
    markdown: '',
    evidence: await reportEvidence(project),
    ...(agentSummary ? { agent_summary: agentSummary } : {}),
  };
  report.markdown = renderReportMarkdown(project, events, report);
  return report;
}

export async function exportPackage(project: Project, report: Report, events: Event[]): Promise<string> {
  const exportsDir = join(project.evidence_dir, 'exports');
  await mkdir(exportsDir, { recursive: true });
  const name = `${sanitizeFileName(project.id)}-reprolens-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
  const destination = join(exportsDir, name);
  const zip = new AdmZip();
  const manifest = {
    schema_version: 2,
    project_id: project.id,
    name: project.name,
    state: project.state,
    generated_at: report.generated_at,
    snapshot: project.verification ?? null,
    patch: project.patch ?? null,
    run_count: project.runs?.length ?? 0,
    report_summary: report.summary,
    agent_summary: report.agent_summary ? {
      model: report.agent_summary.model,
      source: report.agent_summary.source,
      generated_at: report.agent_summary.generated_at,
      verdict: report.agent_summary.verdict ?? null,
    } : null,
    visual_evidence_count: (project.paper.pages ?? []).filter((page) => page.image_path).length,
  };
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  zip.addFile('project.json', Buffer.from(JSON.stringify(project, null, 2)));
  zip.addFile('events.json', Buffer.from(JSON.stringify(events, null, 2)));
  zip.addFile('report.md', Buffer.from(report.markdown));
  if (report.agent_summary) zip.addFile('agent-summary.md', Buffer.from(report.agent_summary.markdown));
  if (project.patch?.diff) zip.addFile('patch.diff', Buffer.from(project.patch.diff));
  await addIfFile(zip, project.paper_path, `paper/original/${basename(project.paper_path)}`);
  for (const page of project.paper.pages ?? []) {
    if (!page.image_path) continue;
    await addIfFile(zip, page.image_path, `paper/pages/page-${String(page.page_number).padStart(3, '0')}.png`);
  }
  for (const visual of project.paper.visuals ?? []) {
    if (visual.kind === 'page_render') continue;
    await addIfFile(zip, visual.path, `paper/visuals/${basename(visual.path)}`);
  }
  for (const run of project.runs ?? []) {
    for (const path of [run.stdout_path, run.stderr_path]) {
      if (!path) continue;
      const rel = relative(project.evidence_dir, path);
      if (rel.startsWith('..')) continue;
      await addIfFile(zip, path, `evidence/${rel.split('\\').join('/')}`);
    }
  }
  if (project.patch?.code_agent_log_path) {
    await addIfFile(zip, project.patch.code_agent_log_path, 'evidence/codeagent/agent.log');
  }
  await mkdir(dirname(destination), { recursive: true });
  zip.writeZip(destination);
  return destination;
}

export function renderReportMarkdown(project: Project, events: Event[], report: Report): string {
  const verification = project.verification;
  const selectedClaims = (project.claims ?? []).filter((claim) => claim.selected);
  const candidateCount = (project.claims ?? []).length - selectedClaims.length;
  const lines: string[] = [
    `# 实验复现报告：${project.name}`,
    '',
    '| 项目信息 | 内容 |',
    '| --- | --- |',
    `| 项目 ID | \`${project.id}\` |`,
    `| 论文标题 | ${escapeMarkdown(project.paper.title || '未识别')} |`,
    `| 工作流状态 | \`${project.state}\` |`,
    `| 论文文件 | \`${project.paper_path}\` |`,
    `| 代码仓库 | \`${project.repo_path}\` |`,
    `| 论文 SHA-256 | \`${project.paper.sha256 || '未记录'}\` |`,
    `| 报告生成时间 | ${report.generated_at} |`,
    `| 主 Agent 总结模型 | \`${report.agent_summary?.model ?? '尚未生成'}\` |`,
    `| 主 Agent 总结时间 | ${report.agent_summary?.generated_at ?? '尚未生成'} |`,
    '',
    '## 一、主 Agent 总结',
    '',
  ];

  if (report.agent_summary?.markdown.trim()) {
    lines.push(stripLeadingHeading(report.agent_summary.markdown), '');
    lines.push(`> 本总结由主 Agent（\`${report.agent_summary.model}\`，${report.agent_summary.source === 'model' ? '模型生成' : '确定性回退'}）生成，仅解释证据，不参与最终核验判定。`, '');
  } else {
    lines.push('主 Agent 总结尚未生成。请在主工作区点击“重新生成主 Agent 总结”。', '');
  }

  lines.push('## 二、规则核验结论', '');
  if (!verification) {
    lines.push('该项目尚未记录规则核验结果。', '');
  } else {
    lines.push(
      `> **${VERDICT_LABELS[verification.verdict]}**`,
      '',
      '| 核验项 | 数值 |',
      '| --- | --- |',
      `| 指标 | \`${verification.metric}\` |`,
      `| 论文期望值 | \`${formatNumber(verification.expected)}\` |`,
      `| 实验观测值 | \`${formatNumber(verification.observed)}\` |`,
      `| 绝对误差 | \`${formatNumber(Math.abs(verification.observed - verification.expected))}\` |`,
      `| 绝对容差 | \`${verification.tolerance.abs}\` |`,
      `| 相对容差 | \`${verification.tolerance.rel}\` |`,
      `| 判定规则 | \`${verification.rule}\` |`,
    );
    if (verification.note) lines.push(`| 说明 | ${escapeMarkdown(verification.note)} |`);
    lines.push('', `${report.summary}`, '');
  }

  lines.push('## 三、实验主张', '');
  if (selectedClaims.length) {
    for (const claim of selectedClaims) {
      lines.push(
        `### ${claim.claim_id} · ${claim.metric}`,
        '',
        escapeMarkdown(claim.text),
        '',
        `- 论文期望值：\`${formatNumber(claim.expected_value)}\``,
        `- 绝对容差：\`${claim.tolerance.abs}\``,
        `- 相对容差：\`${claim.tolerance.rel}\``,
        `- 论文来源：\`${claim.source.path}:${claim.source.line}\``,
        '',
      );
    }
  } else {
    lines.push('尚未选择实验主张。', '');
  }
  if (candidateCount > 0) {
    lines.push(`> 另有 ${candidateCount} 条未选中的候选主张保留在项目 JSON 与证据包中，未用于本次规则核验。`, '');
  }

  lines.push('## 四、实验计划', '');
  if (project.plans?.length) {
    for (const plan of project.plans) {
      lines.push(
        `### ${plan.claim_id} · ${plan.expected_metric}`,
        '',
        `- 运行命令：\`${plan.command}\``,
        `- 运行镜像：\`${plan.image}\``,
        `- 工作目录：\`${plan.work_dir}\``,
        `- 随机种子：\`${plan.seed}\``,
        `- 指标来源：\`${plan.metric_source.pattern ?? plan.metric_source.kind}\``,
        `- 计划确认：${plan.confirmed ? '已确认' : '未确认'}`,
        '',
      );
    }
  } else {
    lines.push('尚未生成实验计划。', '');
  }

  lines.push('## 五、运行记录', '');
  if (project.runs?.length) {
    for (const run of project.runs) {
      lines.push(
        `### 第 ${run.attempt} 次运行`,
        '',
        `- 状态：\`${run.status}\``,
        `- 执行器：\`${run.runner}\``,
        `- 退出码：\`${run.exit_code}\``,
        `- 耗时：\`${run.duration_ms} ms\``,
        `- 命令：\`${run.command}\``,
        `- GPU：${run.gpu ? '是' : '否'}`,
      );
      if (run.metric) lines.push(`- 提取指标：\`${run.metric.name}=${formatNumber(run.metric.value)}\``);
      if (run.remote_job_id) lines.push(`- 远程 Job：\`${run.remote_job_id}\``);
      if (run.failure_class) lines.push(`- 失败分类：\`${run.failure_class}\``, `- 根因摘要：${escapeMarkdown(run.failure_summary ?? '')}`);
      lines.push('');
    }
  } else {
    lines.push('尚未记录运行。', '');
  }

  lines.push('## 六、补丁与人工审批', '');
  if (project.patch) {
    lines.push(
      `- 补丁状态：\`${project.patch.status}\``,
      `- 审批人：\`${project.patch.approved_by ?? '未记录'}\``,
      `- 诊断：${escapeMarkdown(project.patch.diagnosis.failure_class)} — ${escapeMarkdown(project.patch.diagnosis.root_cause)}`,
    );
    if (project.patch.code_agent) {
      lines.push(`- 代码 Agent：\`${project.patch.code_agent}\`${project.patch.code_agent_version ? `（${project.patch.code_agent_version}）` : ''}`);
      if (project.patch.code_agent_log_path) lines.push(`- Agent 日志：\`${project.patch.code_agent_log_path}\``);
    }
    lines.push('', '```diff', project.patch.diff.trim(), '```', '');
  } else {
    lines.push('本次流程未产生代码补丁。', '');
  }

  const notableEvents = events.filter((event) => event.type !== 'run_output');
  const outputEvents = events.filter((event) => event.type === 'run_output');
  lines.push('## 七、关键事件日志', '');
  if (notableEvents.length) {
    for (const event of notableEvents) lines.push(`- \`#${event.seq}\` **${event.type}** — ${escapeMarkdown(event.message)}`);
    if (outputEvents.length) lines.push('', `> 运行过程共归档 ${outputEvents.length} 个流式输出块，全文保存在证据包中，不在报告正文重复展开。`);
  } else {
    lines.push('尚无关键事件。');
  }
  lines.push('');

  lines.push('## 八、证据索引', '');
  if (report.evidence?.length) {
    for (const evidence of report.evidence) {
      const size = evidence.size === undefined ? '' : ` · ${formatBytes(evidence.size)}`;
      lines.push(`- ${evidenceLabel(evidence.kind)}：\`${evidence.path}\`${size}`);
    }
  } else {
    lines.push('尚无证据文件。');
  }
  lines.push('');

  return lines.join('\n');
}

function stripLeadingHeading(markdown: string): string {
  return markdown.trim().replace(/^##\s+主 Agent 总结\s*\n+/i, '').trim();
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+.!|>-])/g, '\\$1');
}

function evidenceLabel(kind: string): string {
  return ({ stdout: '标准输出日志', stderr: '标准错误日志', patch: '补丁', code_agent_log: 'CodeAgent 日志' } as Record<string, string>)[kind] ?? kind;
}

async function reportEvidence(project: Project): Promise<EvidenceRef[]> {
  const refs: EvidenceRef[] = [];
  const seen = new Set<string>();
  const add = async (kind: string, path: string | undefined): Promise<void> => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    const info = await stat(path).catch(() => null);
    refs.push({ kind, path, ...(info ? { size: info.size } : {}) });
  };
  for (const run of project.runs ?? []) {
    await add('stdout', run.stdout_path);
    await add('stderr', run.stderr_path);
  }
  if (project.patch?.code_agent_log_path) await add('code_agent_log', project.patch.code_agent_log_path);
  return refs.sort((a, b) => a.kind.localeCompare(b.kind));
}

async function addIfFile(zip: AdmZip, source: string, destination: string): Promise<void> {
  const info = await stat(source).catch(() => null);
  if (!info?.isFile()) return;
  zip.addFile(destination, await readFile(source));
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-') || 'project';
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(8)));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}