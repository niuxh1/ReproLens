import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Analyzer } from './analyzer.js';
import type { Claim, Diagnosis, ExperimentPlan, Paper, RepoSummary, Run } from '../domain/types.js';

export interface OpenAIAnalyzerOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  vision?: boolean;
}

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type MessageContent = string | ContentPart[];
type ChatMessage = { role: 'system' | 'user'; content: MessageContent };

class HttpStatusError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`LLM request failed with HTTP ${status}: ${body}`);
    this.name = 'HttpStatusError';
  }
}

const claimEnvelope = z.object({
  claims: z.array(z.object({
    claim_id: z.string().optional(),
    text: z.string(),
    metric: z.string(),
    expected_value: z.coerce.number(),
    tolerance: z.object({ abs: z.coerce.number().optional(), rel: z.coerce.number().optional() }).optional(),
    source: z.object({ line: z.coerce.number().optional(), quote: z.string().optional() }).optional(),
  })).min(1),
});

const planSchema = z.object({
  command: z.string().optional(),
  image: z.string().optional(),
  work_dir: z.string().optional(),
  seed: z.coerce.number().optional(),
  metric_source: z.object({ kind: z.string().optional(), path: z.string().optional(), pattern: z.string().optional(), key: z.string().optional() }).optional(),
  notes: z.string().optional(),
});

const diagnosisSchema = z.object({
  failure_class: z.string().optional(),
  root_cause: z.string().optional(),
  confidence: z.string().optional(),
  patch_diff: z.string().optional(),
  explanation: z.string().optional(),
  needs_code_agent: z.boolean().optional(),
});

export class OpenAICompatibleAnalyzer implements Analyzer {
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly vision: boolean;

  constructor(options: OpenAIAnalyzerOptions) {
    this.baseURL = options.baseURL.trim().replace(/\/+$/, '');
    this.apiKey = options.apiKey.trim();
    this.model = options.model.trim();
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 60_000;
    this.vision = options.vision ?? true;
    if (!this.baseURL) throw new Error('LLM base URL is empty');
    try {
      const parsed = new URL(this.baseURL);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('scheme');
    } catch {
      throw new Error(`invalid LLM base URL ${JSON.stringify(this.baseURL)}`);
    }
    if (!this.apiKey) throw new Error('LLM API key is empty');
    if (!this.model) throw new Error('LLM model is empty');
  }

  async extractClaims(paper: Paper, repo: RepoSummary): Promise<Claim[]> {
    const numbered = numberLines(paper.text);
    const prompt = [
      'Extract measurable experimental claims from the paper. Return only JSON with shape',
      '{"claims":[{"claim_id":"C1","text":"...","metric":"accuracy","expected_value":0.81,"tolerance":{"abs":0.01,"rel":0},"source":{"line":3,"quote":"..."}}]}.',
      'Only include claims backed by a numeric metric in the supplied text. Every source.line must refer to the numbered line.',
      'Never invent a value. If a claim depends on a chart, table, or figure, inspect the supplied page image and cite the page in the quote.',
      `Repository summary:\n${summarizeRepo(repo)}`,
      `Visual evidence inventory:\n${summarizeVisuals(paper)}`,
      `Numbered paper:\n${numbered}`,
    ].join('\n\n');
    const images = this.vision ? await loadPageImages(paper) : [];
    const content = await this.chat(
      'You are a conservative scientific claim extractor. Return valid JSON only.',
      prompt,
      images,
    );
    let parsed: z.infer<typeof claimEnvelope>;
    try {
      parsed = claimEnvelope.parse(decodeJSONObject(content));
    } catch (error) {
      throw new Error(`parse claims JSON: ${(error as Error).message}`);
    }
    const lineCount = paper.text.split(/\r?\n/).length;
    const claims: Claim[] = [];
    for (const [index, raw] of parsed.claims.slice(0, 20).entries()) {
      const metric = normalizeMetric(raw.metric);
      const value = raw.expected_value;
      if (!metric || !Number.isFinite(value)) throw new Error(`LLM returned invalid claim ${index + 1}`);
      const abs = raw.tolerance?.abs ?? 0;
      const rel = raw.tolerance?.rel ?? 0;
      if (abs < 0 || rel < 0) throw new Error('LLM returned negative tolerance');
      const sourceLine = raw.source?.line && raw.source.line >= 1 && raw.source.line <= lineCount ? Math.trunc(raw.source.line) : 0;
      claims.push({
        claim_id: raw.claim_id?.trim() || `C${index + 1}`,
        text: raw.text.trim(),
        metric,
        expected_value: value,
        tolerance: abs === 0 && rel === 0 ? { abs: 0.01, rel: 0 } : { abs, rel },
        source: { path: paper.source_path, line: sourceLine, ...(raw.source?.quote ? { quote: raw.source.quote } : {}) },
        selected: false,
      });
    }
    return claims;
  }

  async buildPlan(claim: Claim, paper: Paper, repo: RepoSummary): Promise<ExperimentPlan> {
    const prompt = [
      'Build one reproducible experiment plan for the selected claim. Return only JSON with shape',
      '{"command":"python run.py --seed 42","image":"python:3.11-slim","work_dir":".","seed":42,"metric_source":{"kind":"stdout_regex","path":"","pattern":"(?i)accuracy\\\\s*[:=]\\\\s*([0-9.]+)"},"notes":"..."}.',
      'Use a single shell command without pipes, redirection, command substitution, or multiple statements.',
      'Prefer a command documented in the paper or README. Do not change the selected claim or its expected value.',
      `Claim:\n${claimSummary(claim)}`,
      `Repository:\n${summarizeRepo(repo)}`,
      `Visual evidence inventory:\n${summarizeVisuals(paper)}`,
      `Paper excerpt:\n${truncate(paper.text, 12000)}`,
    ].join('\n\n');
    const content = await this.chat('You are a conservative computational reproduction planner. Return valid JSON only.', prompt);
    let plan: z.infer<typeof planSchema>;
    try {
      plan = planSchema.parse(decodeJSONObject(content));
    } catch (error) {
      throw new Error(`parse plan JSON: ${(error as Error).message}`);
    }
    const command = (plan.command ?? '').trim();
    validateCommand(command);
    const metric = normalizeMetric(claim.metric);
    const metricSource = plan.metric_source;
    return {
      id: `plan_${claim.claim_id.toLowerCase()}`,
      claim_id: claim.claim_id,
      command,
      image: (plan.image || 'python:3.11-slim').trim(),
      work_dir: (plan.work_dir || '.').trim(),
      seed: Number.isInteger(plan.seed) ? plan.seed! : 42,
      expected_metric: metric,
      expected_value: claim.expected_value,
      tolerance: claim.tolerance,
      metric_source: {
        kind: metricSource?.kind || 'stdout_regex',
        ...(metricSource?.path ? { path: metricSource.path } : {}),
        pattern: metricSource?.pattern || `(?i)${escapeRegex(metric)}\\s*[:=]\\s*([-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+))`,
        key: metricSource?.key || metric,
      },
      ...(plan.notes ? { notes: plan.notes } : {}),
      confirmed: false,
    };
  }

  async diagnose(run: Run, _repo: RepoSummary, _workspace: string): Promise<Diagnosis> {
    const prompt = [
      'Diagnose this failed reproduction run. Return only JSON with shape',
      '{"failure_class":"dependency_missing","root_cause":"...","confidence":"high","patch_diff":"--- a/file\\n+++ b/file\\n@@ ...","explanation":"...","needs_code_agent":true}.',
      'Only propose a patch that preserves the paper claim, data split, metric definition, and expected value.',
      'If no safe patch can be produced, omit patch_diff and set needs_code_agent to true.',
      `Run:\n${runSummary(run)}`,
    ].join('\n\n');
    const content = await this.chat('You are a conservative failure diagnostician. Return valid JSON only.', prompt);
    let raw: z.infer<typeof diagnosisSchema>;
    try {
      raw = diagnosisSchema.parse(decodeJSONObject(content));
    } catch (error) {
      throw new Error(`parse diagnosis JSON: ${(error as Error).message}`);
    }
    const patchDiff = raw.patch_diff?.trim() ?? '';
    return {
      failure_class: (raw.failure_class || 'unknown').trim(),
      root_cause: (raw.root_cause || 'diagnosis did not identify a root cause').trim(),
      confidence: (raw.confidence || 'low').trim(),
      ...(patchDiff.startsWith('--- a/') ? { patch_diff: patchDiff } : {}),
      ...(raw.explanation ? { explanation: raw.explanation } : {}),
      ...(raw.needs_code_agent ? { needs_code_agent: true } : {}),
    };
  }

  private async chat(system: string, user: string, images: string[] = []): Promise<string> {
    const userContent: MessageContent = images.length > 0
      ? [{ type: 'text', text: user }, ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))]
      : user;
    const messages: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: userContent }];
    try {
      return await this.doChat(messages, true);
    } catch (error) {
      if (!(error instanceof HttpStatusError) || (error.status !== 400 && error.status !== 422)) throw error;
      if (images.length > 0) {
        const textOnly: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: user }];
        try {
          return await this.doChat(textOnly, true);
        } catch (secondError) {
          if (!(secondError instanceof HttpStatusError) || (secondError.status !== 400 && secondError.status !== 422)) throw secondError;
          return this.doChat(textOnly, false);
        }
      }
      return this.doChat(messages, false);
    }
  }

  private async doChat(messages: ChatMessage[], responseFormat: boolean): Promise<string> {
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0.1,
        max_tokens: 4096,
        ...(responseFormat ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const raw = (await response.text()).slice(0, 4 * 1024 * 1024);
    if (!response.ok) {
      throw new HttpStatusError(response.status, raw.trim().slice(0, 600));
    }
    let parsed: { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch (error) {
      throw new Error(`decode LLM response: ${(error as Error).message}`);
    }
    if (parsed.error?.message) throw new Error(`LLM error: ${parsed.error.message}`);
    const content = parsed.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('LLM returned no message content');
    return content;
  }
}

export function validateCommand(command: string): void {
  if (!command.trim()) throw new Error('command is empty');
  if (/[\r\n]/.test(command)) throw new Error('command must be a single line');
  if (/&&|\|\||;|\||>|<|`|\$\(|\$\{/.test(command)) throw new Error('command contains unsupported shell composition');
  if (!/^\s*(python(?:3)?|pytest|rscript|bash|sh|go\s+test|node|uv\s+run|poetry\s+run|pip(?:3)?)\b/i.test(command)) {
    throw new Error(`command executable is not allowed: ${JSON.stringify(command)}`);
  }
}

async function loadPageImages(paper: Paper): Promise<string[]> {
  const paths: string[] = [];
  for (const page of paper.pages ?? []) {
    if (page.image_path) paths.push(page.image_path);
  }
  if (paths.length === 0) {
    for (const visual of paper.visuals ?? []) {
      if (visual.kind === 'page_render' || visual.kind === 'figure' || visual.kind === 'table') paths.push(visual.path);
    }
  }
  const images: string[] = [];
  for (const path of [...new Set(paths)].slice(0, 4)) {
    try {
      const data = await readFile(path);
      if (data.length <= 8 * 1024 * 1024) images.push(`data:image/png;base64,${data.toString('base64')}`);
    } catch {
      // The textual page inventory remains available if an image cannot be read.
    }
  }
  return images;
}

function decodeJSONObject(content: string): unknown {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object found');
  return JSON.parse(content.slice(start, end + 1)) as unknown;
}

function numberLines(text: string): string {
  return text.split(/\r?\n/).map((line, index) => `[L${index + 1}] ${line}`).join('\n');
}

function summarizeRepo(repo: RepoSummary): string {
  return [
    repo.readme ? `README:\n${truncate(repo.readme, 8000)}` : '',
    repo.files.length ? `Files: ${repo.files.slice(0, 80).join(', ')}` : '',
    repo.command_candidates.length ? `Commands: ${repo.command_candidates.join(' | ')}` : '',
    repo.requirements?.length ? `Requirements: ${repo.requirements.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

function summarizeVisuals(paper: Paper): string {
  const pages = paper.pages ?? [];
  if (pages.length === 0 && (paper.visuals?.length ?? 0) === 0) return 'No page images were available.';
  const lines = pages.map((page) => `page ${page.page_number}: image=${page.image_path ?? 'none'}; captions=${page.caption_candidates.join(' | ') || 'none'}`);
  for (const visual of paper.visuals ?? []) lines.push(`visual ${visual.kind} page ${visual.page_number}: ${visual.path}`);
  return lines.join('\n');
}

function claimSummary(claim: Claim): string {
  return `id=${claim.claim_id} metric=${claim.metric} expected=${claim.expected_value} tolerance_abs=${claim.tolerance.abs} tolerance_rel=${claim.tolerance.rel} source=${claim.source.path}:${claim.source.line} text=${claim.text}`;
}

function runSummary(run: Run): string {
  return `status=${run.status} exit=${run.exit_code} runner=${run.runner} command=${run.command}\nstdout:\n${truncate(run.stdout ?? '', 8000)}\nstderr:\n${truncate(run.stderr ?? '', 8000)}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated]`;
}

function normalizeMetric(metric: string): string {
  const normalized = metric.trim().toLowerCase().replace(/\s+/g, '-');
  return normalized === 'f1-score' || normalized === 'f1score' ? 'f1' : normalized;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
