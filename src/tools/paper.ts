import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import AdmZip from 'adm-zip';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Paper, PaperPage, PaperVisual } from '../domain/types.js';

const MAX_PAPER_BYTES = 80 * 1024 * 1024;
const MAX_PDF_PAGES = 100;
const PAGE_RENDER_SCALE = 1.5;

export interface ParsePaperOptions {
  visualDir?: string;
  renderPages?: boolean;
}

export async function parsePaper(path: string, options: ParsePaperOptions = {}): Promise<Paper> {
  const info = await lstat(path);
  if (info.size > MAX_PAPER_BYTES) throw new Error('paper exceeds size limit');
  const raw = await readFile(path);
  const ext = extname(path).toLowerCase();
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const visualDir = options.visualDir ?? join(tmpdir(), 'reprolens-pages', sha256.slice(0, 16));
  let text: string;
  let pages: PaperPage[] | undefined;
  let visuals: PaperVisual[] | undefined;
  if (['.md', '.markdown', '.txt', '.rst'].includes(ext)) {
    text = raw.toString('utf8');
  } else if (ext === '.docx') {
    const extracted = await extractDocx(raw);
    text = extracted.text;
    visuals = await extractDocxVisuals(raw, visualDir);
  } else if (ext === '.pdf') {
    const extracted = await extractPdf(raw, visualDir, options.renderPages !== false);
    text = extracted.text;
    pages = extracted.pages;
    visuals = extracted.visuals;
  } else {
    throw new Error(`unsupported paper format ${JSON.stringify(ext)}`);
  }
  return {
    title: paperTitle(text),
    text,
    source_path: path,
    sha256,
    claims: [],
    parsed_at: new Date().toISOString(),
    ...(pages ? { pages } : {}),
    ...(visuals && visuals.length > 0 ? { visuals } : {}),
  };
}

interface ExtractedDocx {
  text: string;
  paragraphs: string[];
}

async function extractDocx(raw: Buffer): Promise<ExtractedDocx> {
  const zip = new AdmZip(raw);
  const entry = zip.getEntry('word/document.xml');
  if (!entry) throw new Error('docx has no word/document.xml');
  const xml = entry.getData().toString('utf8');
  const paragraphs: string[] = [];
  for (const match of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gi)) {
    const runs = [...match[1]!.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi)].map((run) => decodeXml(run[1]!));
    paragraphs.push(runs.join(''));
  }
  return { text: paragraphs.join('\n'), paragraphs };
}

async function extractDocxVisuals(raw: Buffer, visualDir: string): Promise<PaperVisual[]> {
  const zip = new AdmZip(raw);
  const visuals: PaperVisual[] = [];
  const mediaDir = join(visualDir, 'docx-media');
  for (const entry of zip.getEntries()) {
    if (!entry.entryName.startsWith('word/media/') || entry.isDirectory) continue;
    await mkdir(mediaDir, { recursive: true });
    const name = basename(entry.entryName);
    const target = join(mediaDir, name);
    await writeFile(target, entry.getData());
    visuals.push({ kind: 'embedded_image', page_number: 1, path: target });
  }
  return visuals;
}

interface ExtractedPdf {
  text: string;
  pages: PaperPage[];
  visuals: PaperVisual[];
}

async function extractPdf(raw: Buffer, visualDir: string, renderPages: boolean): Promise<ExtractedPdf> {
  const loading = pdfjs.getDocument({
    data: new Uint8Array(raw),
    disableFontFace: true,
    useSystemFonts: true,
  });
  const document = await loading.promise;
  const pageCount = Math.min(document.numPages, MAX_PDF_PAGES);
  const pages: PaperPage[] = [];
  const visuals: PaperVisual[] = [];
  if (renderPages) await mkdir(visualDir, { recursive: true });
  for (let index = 1; index <= pageCount; index += 1) {
    const page = await document.getPage(index);
    const content = await page.getTextContent();
    const lines: string[] = [];
    let current = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      current += item.str;
      if (item.hasEOL) {
        lines.push(current.trimEnd());
        current = '';
      } else if (item.str && !item.str.endsWith(' ')) {
        current += ' ';
      }
    }
    if (current.trim()) lines.push(current.trimEnd());
    const pageText = lines.join('\n').trim();
    const captionCandidates = lines
      .map((line) => line.trim())
      .filter((line) => /^(figure|fig\.?|table|图|表)\s*[0-9一二三四五六七八九十]+/i.test(line));
    let imagePath: string | undefined;
    let width: number | undefined;
    let height: number | undefined;
    if (renderPages) {
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(PAGE_RENDER_SCALE, 1800 / Math.max(baseViewport.width, 1));
      const viewport = page.getViewport({ scale });
      width = Math.ceil(viewport.width);
      height = Math.ceil(viewport.height);
      const canvas = createCanvas(width, height);
      const context = canvas.getContext('2d');
      await page.render({ canvas: canvas as any, canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
      imagePath = join(visualDir, `page-${String(index).padStart(3, '0')}.png`);
      await writeFile(imagePath, canvas.toBuffer('image/png'));
      visuals.push({ kind: 'page_render', page_number: index, path: imagePath, width, height, ...(captionCandidates[0] ? { caption: captionCandidates[0] } : {}) });
    }
    pages.push({
      page_number: index,
      text: pageText,
      ...(imagePath ? { image_path: imagePath } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      caption_candidates: captionCandidates,
    });
  }
  await document.destroy();
  const text = pages.map((page) => page.text).filter(Boolean).join('\n\n');
  return { text, pages, visuals };
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function paperTitle(text: string): string {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^#+\s*/, '');
    if (line) return line.slice(0, 180);
  }
  return 'Untitled paper';
}
