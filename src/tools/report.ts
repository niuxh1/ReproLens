import AdmZip from 'adm-zip';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import type { Event, EvidenceRef, Project, Report } from '../domain/types.js';

export async function buildReport(project: Project, events: Event[]): Promise<Report> {
  const now = new Date().toISOString();
  const summary = project.verification
    ? `${project.verification.verdict}: observed ${formatNumber(project.verification.observed)} vs expected ${formatNumber(project.verification.expected)} for ${project.verification.metric}`
    : 'No rule-based verification has been recorded.';
  const report: Report = {
    report_id: `report_${project.id}`,
    generated_at: now,
    summary,
    markdown: '',
    evidence: await reportEvidence(project),
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
    schema_version: 1,
    project_id: project.id,
    name: project.name,
    state: project.state,
    generated_at: report.generated_at,
    snapshot: project.verification ?? null,
    patch: project.patch ?? null,
    run_count: project.runs?.length ?? 0,
    report_summary: report.summary,
    visual_evidence_count: (project.paper.pages ?? []).filter((page) => page.image_path).length,
  };
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  zip.addFile('project.json', Buffer.from(JSON.stringify(project, null, 2)));
  zip.addFile('events.json', Buffer.from(JSON.stringify(events, null, 2)));
  zip.addFile('report.md', Buffer.from(report.markdown));
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

function renderReportMarkdown(project: Project, events: Event[], report: Report): string {
  const lines: string[] = [
    `# ReproLens Report: ${project.name}`,
    '',
    `- Project ID: \`${project.id}\``,
    `- State: \`${project.state}\``,
    `- Paper: \`${project.paper_path}\``,
    `- Repository: \`${project.repo_path}\``,
    `- Paper SHA-256: \`${project.paper.sha256}\``,
    `- Generated: ${report.generated_at}`,
    '',
    '## Rule-based verdict',
    '',
  ];
  if (!project.verification) {
    lines.push('No verification was recorded.', '');
  } else {
    const verification = project.verification;
    lines.push(
      `**${verification.verdict}** — ${report.summary}`,
      '',
      `- Expected: \`${formatNumber(verification.expected)}\``,
      `- Observed: \`${formatNumber(verification.observed)}\``,
      `- Tolerance: abs=\`${verification.tolerance.abs}\`, rel=\`${verification.tolerance.rel}\``,
      `- Rule: \`${verification.rule}\``,
      ...(verification.note ? [`- Note: ${verification.note}`] : []),
      '',
    );
  }
  if (project.claims?.length) {
    lines.push('## Claims', '');
    for (const claim of project.claims) {
      lines.push(`- \`${claim.claim_id}\` ${claim.text} — expected \`${formatNumber(claim.expected_value)}\` (abs tolerance \`${claim.tolerance.abs}\`), source \`${claim.source.path}:${claim.source.line}\``);
    }
    lines.push('');
  }
  if (project.plans?.length) {
    lines.push('## Experiment plan', '');
    for (const plan of project.plans) lines.push(`- Claim \`${plan.claim_id}\`: \`${plan.command}\` (image \`${plan.image}\`, seed \`${plan.seed}\`)`);
    lines.push('');
  }
  if (project.runs?.length) {
    lines.push('## Run history', '');
    for (const run of project.runs) {
      lines.push(`- Attempt ${run.attempt}: \`${run.status}\` exit=\`${run.exit_code}\` runner=\`${run.runner}\`${run.gpu ? ' GPU' : ''}`);
      if (run.failure_class) lines.push(`  - Diagnosis: \`${run.failure_class}\` — ${run.failure_summary ?? ''}`);
    }
    lines.push('');
  }
  if (project.patch) {
    lines.push('## Patch', '', `- Status: \`${project.patch.status}\``, `- Approved by: \`${project.patch.approved_by ?? 'not recorded'}\``, `- Diagnosis: ${project.patch.diagnosis.failure_class} — ${project.patch.diagnosis.root_cause}`);
    if (project.patch.code_agent) {
      lines.push(`- Code agent: \`${project.patch.code_agent}\`${project.patch.code_agent_version ? ` (${project.patch.code_agent_version})` : ''}`);
      if (project.patch.code_agent_log_path) lines.push(`- Code agent log: \`${project.patch.code_agent_log_path}\``);
    }
    lines.push('', '```diff', project.patch.diff.trim(), '```', '');
  }
  if (events.length) {
    lines.push('## Event log', '');
    for (const event of events) lines.push(`- #${event.seq} ${event.type} — ${event.message}`);
    lines.push('');
  }
  if (report.evidence?.length) {
    lines.push('## Evidence index', '');
    for (const evidence of report.evidence) lines.push(`- ${evidence.kind}: \`${evidence.path}\``);
  }
  return lines.join('\n');
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
  await add('paper', project.paper_path);
  for (const page of project.paper.pages ?? []) await add('paper_page', page.image_path);
  for (const run of project.runs ?? []) {
    await add('stdout', run.stdout_path);
    await add('stderr', run.stderr_path);
  }
  if (project.patch) {
    await add('patch', project.patch.code_agent_log_path);
    await add('code_agent_log', project.patch.code_agent_log_path);
  }
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
