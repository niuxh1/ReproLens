import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeuristicAnalyzer } from '../src/agent/heuristic.js';
import type { Event, Project } from '../src/domain/types.js';
import { buildServer } from '../src/httpapi/server.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { LocalRunner } from '../src/tools/local-runner.js';
import { buildReport } from '../src/tools/report.js';
import { renderReportPage } from '../src/httpapi/report-page.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function completedProject(dir: string, now: string): Project {
  return {
    id: 'p_report', name: 'Grokfast 复现', state: 'COMPLETED', paper_path: join(dir, 'paper.pdf'), repo_path: dir,
    workspace_path: dir, evidence_dir: dir, budget: { max_runs: 3, max_seconds: 120, max_patches: 2 },
    paper: { title: 'Grokfast', text: '', source_path: join(dir, 'paper.pdf'), sha256: 'abc', claims: [], parsed_at: now, pages: [] },
    repo: { root: dir, files: [], command_candidates: [], scanned_at: now },
    claims: [{ claim_id: 'C1', text: '910 iterations', metric: 'iterations', expected_value: 910, tolerance: { abs: 300, rel: 0 }, source: { path: join(dir, 'paper.pdf'), line: 1 }, selected: true }],
    verification: { verification_id: 'v1', claim_id: 'C1', metric: 'iterations', expected: 910, observed: 900, tolerance: { abs: 300, rel: 0 }, verdict: 'PASS', rule: 'abs_error 10 <= 300', verified_at: now },
    created_at: now, updated_at: now,
  };
}

describe('report document', () => {
  it('renders a readable, printable document with the main agent summary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reprolens-report-page-'));
    dirs.push(dir);
    await writeFile(join(dir, 'paper.pdf'), '%PDF-1.4\n');
    const now = new Date().toISOString();
    const project = completedProject(dir, now);
    const events: Event[] = [{ id: 1, project_id: project.id, seq: 1, type: 'metric_verified', message: 'rule-based verdict PASS', created_at: now }];
    const summary = await new HeuristicAnalyzer().summarizeReport(project, events);
    const report = await buildReport(project, events, summary);
    report.markdown += '\n\n<meta http-equiv="refresh" content="0;url=https://example.com">\n<iframe srcdoc="x"></iframe>\n<img src="https://example.com/x" onerror="alert(1)">\n<a href="javascript:alert(1)">bad</a>';
    const html = renderReportPage(project, report);
    expect(html).toContain('主 Agent 总结');
    expect(html).toContain('通过');
    expect(html).toContain('PASS');
    expect(html).toContain('deterministic-heuristic');
    expect(html).toContain('证据成熟度评分');
    expect(html).toContain('@media print');
    expect(html).toContain('重新生成总结');
    expect(html).toContain('确定性数值规则');
    expect(html).not.toContain('<meta http-equiv="refresh"');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('onerror=');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('frame-ancestors');
    expect(html).toContain('reprolens-report-height');
  });

  it('serves report HTML and regenerates the summary through the API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reprolens-report-api-'));
    dirs.push(dir);
    await writeFile(join(dir, 'paper.pdf'), '%PDF-1.4\n');
    const now = new Date().toISOString();
    const store = new MemoryStore();
    const project = completedProject(dir, now);
    const events: Event[] = [{ id: 1, project_id: project.id, seq: 1, type: 'metric_verified', message: 'rule-based verdict PASS', created_at: now }];
    project.report = await buildReport(project, events);
    await store.createProject(project);
    await store.appendEvent(project.id, 'metric_verified', 'rule-based verdict PASS');
    const server = await buildServer(new Orchestrator(store, new HeuristicAnalyzer(), new LocalRunner(), dir), dir);
    await server.ready();
    try {
      const page = await server.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/report.html` });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.headers['content-security-policy']).toContain("frame-ancestors 'self'");
      expect(page.body).toContain('实验复现报告');
      const missing = await server.inject({ method: 'GET', url: '/api/v1/projects/missing/report.html' });
      expect(missing.statusCode).toBe(404);
      expect(missing.headers['content-type']).toContain('text/html');
      expect(missing.headers['content-security-policy']).toContain("frame-ancestors 'self'");
      expect(missing.body).toContain('项目不存在');
      const regenerated = await server.inject({ method: 'POST', url: `/api/v1/projects/${project.id}/report/summarize`, payload: {} });
      expect(regenerated.statusCode).toBe(200);
      expect((regenerated.json() as Project).report?.agent_summary?.source).toBe('heuristic');
    } finally {
      await server.close();
    }
  });
});