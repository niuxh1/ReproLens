import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { parsePaper } from '../src/tools/paper.js';
import { scanRepo } from '../src/tools/repo.js';
import { Workspace } from '../src/tools/workspace.js';
import { PatchManager } from '../src/tools/patch.js';
import { createWorkspaceArchive } from '../src/tools/archive.js';

const dirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('paper ingestion', () => {
  it('extracts DOCX paragraphs and hashes the source', async () => {
    const dir = await tempDir('reprolens-docx-');
    const path = join(dir, 'paper.docx');
    const zip = new AdmZip();
    zip.addFile('word/document.xml', Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Claim C1: accuracy = 0.81</w:t></w:r></w:p><w:p><w:r><w:t>tolerance ±0.01</w:t></w:r></w:p></w:body></w:document>',
    ));
    zip.writeZip(path);
    const paper = await parsePaper(path);
    expect(paper.text).toContain('Claim C1');
    expect(paper.text).toContain('0.81');
    expect(paper.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('renders PDF pages as visual evidence and preserves figure captions', async () => {
    const dir = await tempDir('reprolens-pdf-');
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([612, 792]);
    page.drawText('Claim C1: accuracy = 0.81 (tolerance 0.01)', { x: 72, y: 720, size: 12, font, color: rgb(0, 0, 0) });
    page.drawText('Figure 1: Accuracy changes across seeds', { x: 72, y: 680, size: 10, font, color: rgb(0, 0, 0) });
    page.drawRectangle({ x: 72, y: 500, width: 300, height: 140, borderColor: rgb(0, 0, 0), borderWidth: 1 });
    const path = join(dir, 'paper.pdf');
    await writeFile(path, await pdf.save());
    const visualDir = join(dir, 'visuals');
    const paper = await parsePaper(path, { visualDir });
    expect(paper.text).toContain('Claim C1');
    expect(paper.pages).toHaveLength(1);
    expect(paper.pages?.[0]?.image_path).toBeTruthy();
    expect((await stat(paper.pages![0]!.image_path!)).size).toBeGreaterThan(1000);
    expect(paper.pages?.[0]?.caption_candidates.join(' ')).toContain('Figure 1');
    expect(paper.visuals?.[0]?.kind).toBe('page_render');
    expect(paper.visuals?.[0]?.page_number).toBe(1);
  });
});

describe('workspace and repository scan', () => {
  it('copies a repo and rejects traversal paths', async () => {
    const dataDir = await tempDir('reprolens-workspace-');
    const ws = await Workspace.create(dataDir, 'p1');
    expect(() => ws.resolvePath('../escape.txt')).toThrow(/escapes/);
    expect(() => ws.resolvePath('nested/../ok.txt')).not.toThrow();
    const source = join(dataDir, 'repo');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'README.md'), '# demo\n');
    await ws.copyRepo(source);
    expect(await readFile(join(ws.root, 'README.md'), 'utf8')).toContain('# demo');
  });

  it('finds README commands, requirements, and files', async () => {
    const dir = await tempDir('reprolens-repo-');
    await writeFile(join(dir, 'README.md'), '# Demo\n\n```bash\npython train.py --seed 42\n```\n');
    await writeFile(join(dir, 'train.py'), "print('ok')\n");
    await writeFile(join(dir, 'requirements.txt'), 'numpy==1.26\n');
    const repo = await scanRepo(dir);
    expect(repo.readme).toContain('python train.py');
    expect(repo.command_candidates[0]).toBe('python train.py --seed 42');
    expect(repo.requirements).toEqual(['numpy==1.26']);
    expect(repo.files).toContain('train.py');
  });
});

describe('patch manager', () => {
  it('rejects traversal and applies a valid unified diff', async () => {
    const dir = await tempDir('reprolens-patch-');
    const ws = await Workspace.create(dir, 'p2');
    await writeFile(join(ws.root, 'run_experiment.py'), "import sys\nSEED = 0\nprint('accuracy=0.50')\n");
    const manager = new PatchManager(ws.root);
    await expect(manager.validate('--- a/../escape.py\n+++ b/../escape.py\n@@ -1 +1 @@\n-x\n+y\n')).rejects.toThrow(/escapes/);
    const diff = '--- a/run_experiment.py\n+++ b/run_experiment.py\n@@ -1,3 +1,3 @@\n import sys\n-SEED = 0\n+SEED = 42\n print(\'accuracy=0.50\')\n';
    await expect(manager.apply(diff)).resolves.toEqual(['run_experiment.py']);
    expect(await readFile(join(ws.root, 'run_experiment.py'), 'utf8')).toContain('SEED = 42');
  });

  it('supports creating a new file but refuses deletion', async () => {
    const dir = await tempDir('reprolens-patch-new-');
    const ws = await Workspace.create(dir, 'p3');
    await writeFile(join(ws.root, 'run.py'), "print('old')\n");
    const manager = new PatchManager(ws.root);
    const createDiff = '--- /dev/null\n+++ b/implementation.py\n@@ -0,0 +1,2 @@\n+def solve():\n+    return 42\n';
    await expect(manager.apply(createDiff)).resolves.toEqual(['implementation.py']);
    expect(await readFile(join(ws.root, 'implementation.py'), 'utf8')).toContain('return 42');
    const deleteDiff = '--- a/run.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-print(\'old\')\n';
    await expect(manager.validate(deleteDiff)).rejects.toThrow(/deletion/);
  });
});

describe('workspace archive', () => {
  it('creates a gzip archive without .git', async () => {
    const dir = await tempDir('reprolens-archive-');
    const ws = await Workspace.create(dir, 'archive_project');
    await mkdir(join(ws.root, 'sub'), { recursive: true });
    await mkdir(join(ws.root, '.git'), { recursive: true });
    await writeFile(join(ws.root, 'sub', 'run.py'), "print('ok')\n");
    await writeFile(join(ws.root, '.git', 'ignored'), 'x');
    const archive = join(dir, 'workspace.tar.gz');
    await createWorkspaceArchive(ws.root, archive);
    const header = await readFile(archive);
    expect(header[0]).toBe(0x1f);
    expect(header[1]).toBe(0x8b);
  });
});
