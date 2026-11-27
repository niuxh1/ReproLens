import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { buildReport, exportPackage } from '../src/tools/report.js';
import type { Project } from '../src/domain/types.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('report and reproduction package', () => {
  it('renders the verdict, evidence, and a downloadable ZIP', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reprolens-report-'));
    dirs.push(dir);
    const paperPath = join(dir, 'paper.pdf');
    await writeFile(paperPath, '%PDF-1.4\n');
    const now = new Date().toISOString();
    const project: Project = {
      id: 'p1', name: 'Demo', state: 'COMPLETED', paper_path: paperPath, repo_path: dir, workspace_path: dir, evidence_dir: dir,
      budget: { max_runs: 3, max_seconds: 120, max_patches: 2 },
      paper: { title: 'Demo', text: 'accuracy 0.81', source_path: paperPath, sha256: 'abc', claims: [], parsed_at: now },
      repo: { root: dir, files: [], command_candidates: [], scanned_at: now },
      claims: [{ claim_id: 'C1', text: 'accuracy 0.81', metric: 'accuracy', expected_value: 0.81, tolerance: { abs: 0.01, rel: 0 }, source: { path: paperPath, line: 1 }, selected: true }],
      verification: { verification_id: 'v1', claim_id: 'C1', metric: 'accuracy', expected: 0.81, observed: 0.81, tolerance: { abs: 0.01, rel: 0 }, verdict: 'PASS', rule: 'abs_error 0 <= 0.01', verified_at: now },
      runs: [],
      created_at: now, updated_at: now,
    };
    const events = [{ id: 1, project_id: 'p1', seq: 1, type: 'project_created', message: 'project created', created_at: now }];
    const report = await buildReport(project, events);
    expect(report.summary).toContain('PASS');
    expect(report.markdown).toContain('规则核验结论');
    expect(report.markdown).toContain('证据成熟度评估');
    expect(report.assessment?.score).toBeGreaterThan(0);
    expect(report.markdown).not.toContain('原始论文');
    expect(report.markdown).not.toContain('论文页面图像');
    const path = await exportPackage(project, report, events);
    const zip = new AdmZip(path);
    expect(zip.getEntry('manifest.json')).toBeTruthy();
    expect(zip.getEntry('report.md')).toBeTruthy();
    expect(zip.getEntry('paper/original/paper.pdf')).toBeTruthy();
    expect(zip.getEntry('events.json')).toBeTruthy();
    expect(zip.getEntry('verification.json')).toBeTruthy();
    expect(zip.getEntry('workspace/workspace.tar.gz')).toBeTruthy();
    expect(zip.getEntry('checksums.json')).toBeTruthy();
    const manifest = JSON.parse(zip.readAsText('manifest.json')) as { workspace_snapshot_bytes: number; checksums_sha256: string; package_schema_version: number };
    expect(manifest.package_schema_version).toBe(3);
    expect(manifest.workspace_snapshot_bytes).toBeGreaterThan(0);
    expect(manifest.checksums_sha256).toMatch(/^[a-f0-9]{64}$/);
    const checksums = JSON.parse(zip.readAsText('checksums.json')) as Record<string, { sha256: string; size: number }>;
    expect(checksums['report.md']?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(checksums['paper/original/paper.pdf']?.size).toBeGreaterThan(0);
  });

  it('reports every claim and a strict aggregate verdict', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reprolens-report-multi-'));
    dirs.push(dir);
    const paperPath = join(dir, 'paper.pdf');
    await writeFile(paperPath, '%PDF-1.4\n');
    const now = new Date().toISOString();
    const first = { verification_id: 'v1', claim_id: 'C1', metric: 'accuracy', expected: 0.81, observed: 0.81, tolerance: { abs: 0.01, rel: 0 }, verdict: 'PASS' as const, rule: 'abs_error 0 <= 0.01', verified_at: now };
    const second = { verification_id: 'v2', claim_id: 'C2', metric: 'loss', expected: 0.2, observed: 0.4, tolerance: { abs: 0.01, rel: 0 }, verdict: 'DIFFERENT' as const, rule: 'abs_error 0.2 <= 0.01', verified_at: now };
    const project: Project = {
      id: 'p_multi', name: 'Multi claim', state: 'COMPLETED', paper_path: paperPath, repo_path: dir, workspace_path: dir, evidence_dir: dir,
      budget: { max_runs: 3, max_seconds: 120, max_patches: 2 },
      paper: { title: 'Multi', text: '', source_path: paperPath, sha256: 'abc', claims: [], parsed_at: now },
      repo: { root: dir, files: [], command_candidates: [], scanned_at: now },
      claims: [
        { claim_id: 'C1', text: 'accuracy 0.81', metric: 'accuracy', expected_value: 0.81, tolerance: { abs: 0.01, rel: 0 }, source: { path: paperPath, line: 1 }, selected: true },
        { claim_id: 'C2', text: 'loss 0.2', metric: 'loss', expected_value: 0.2, tolerance: { abs: 0.01, rel: 0 }, source: { path: paperPath, line: 2 }, selected: true },
      ],
      verification: second,
      verifications: [first, second],
      created_at: now, updated_at: now,
    };
    const report = await buildReport(project, []);
    expect(report.aggregate_verdict).toBe('DIFFERENT');
    expect(report.markdown).toContain('C1');
    expect(report.markdown).toContain('C2');
    expect(report.markdown).toContain('DIFFERENT');
  });
});