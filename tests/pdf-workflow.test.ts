import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { materializeDemo } from '../src/demo.js';
import { HeuristicAnalyzer } from '../src/agent/heuristic.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { LocalRunner } from '../src/tools/local-runner.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('PDF visual evidence workflow', () => {
  it('keeps rendered pages through verification and the evidence package', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reprolens-pdf-flow-'));
    dirs.push(dir);
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([612, 792]);
    page.drawText('Claim C1: accuracy = 0.81 (tolerance 0.01)', { x: 72, y: 720, size: 12, font });
    page.drawText('Figure 1: Accuracy across seeds', { x: 72, y: 680, size: 10, font });
    const paperPath = join(dir, 'paper.pdf');
    await writeFile(paperPath, await pdf.save());
    const demo = await materializeDemo(dir, 'pdf-flow-demo');
    const orchestrator = new Orchestrator(new MemoryStore(), new HeuristicAnalyzer(), new LocalRunner(), dir);
    let project = await orchestrator.createProject({ name: 'PDF flow', paperPath, repoPath: demo.repoPath, budget: { max_runs: 3, max_seconds: 30, max_patches: 2 } });
    project = await orchestrator.start(project.id);
    expect(project.state).toBe('AWAITING_CLAIMS');
    expect(project.paper.pages).toHaveLength(1);
    expect(project.paper.pages?.[0]?.image_path).toBeTruthy();
    expect(project.paper.pages?.[0]?.caption_candidates.join(' ')).toContain('Figure 1');
    project = await orchestrator.selectClaims(project.id, ['C1']);
    project = await orchestrator.confirmPlan(project.id);
    project = await orchestrator.approvePatch(project.id, 'pdf-test');
    expect(project.state).toBe('COMPLETED');
    expect(project.verification?.verdict).toBe('PASS');
    const zip = new AdmZip(project.report?.package_path);
    expect(zip.getEntry('paper/original/paper.pdf')).toBeTruthy();
    expect(zip.getEntry('paper/pages/page-001.png')).toBeTruthy();
  });
});
