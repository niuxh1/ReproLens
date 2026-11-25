import { mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createWorkspaceArchive } from './archive.js';
import { buildExecutionEnv, validateExecutionCommand, writeRunEvidence, type ExecutionRequest, type ExecutionResult, type Runner } from './runner.js';

export interface PlatformRunnerOptions {
  baseURL: string;
  apiKey?: string;
  provider?: string;
  image?: string;
  gpuType?: string;
  minVRAMGB?: number;
  maxHourlyUSD?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  enableGPU?: boolean;
}

export interface PlatformOffer {
  id: string;
  provider: string;
  gpu_type: string;
  vram_gb: number;
  hourly_usd: number;
  available: boolean;
}

export class PlatformRunner implements Runner {
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly provider: string;
  private readonly image: string;
  private readonly gpuType: string;
  private readonly minVRAMGB: number;
  private readonly maxHourlyUSD: number;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  readonly enableGPU: boolean;

  constructor(options: PlatformRunnerOptions) {
    this.baseURL = options.baseURL.trim().replace(/\/+$/, '');
    this.apiKey = options.apiKey?.trim() ?? '';
    this.provider = options.provider || 'colab';
    this.image = options.image || 'python:3.11-slim';
    this.gpuType = options.gpuType || '';
    this.minVRAMGB = options.minVRAMGB ?? 0;
    this.maxHourlyUSD = options.maxHourlyUSD ?? 0;
    this.pollIntervalMs = options.pollIntervalMs && options.pollIntervalMs > 0 ? options.pollIntervalMs : 2000;
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 30 * 60_000;
    this.enableGPU = options.enableGPU ?? false;
    if (!this.baseURL) throw new Error('platform base URL is empty');
  }

  name(): string { return `${this.provider} (rental platform)`; }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    validateExecutionCommand(request.command);
    if (!request.workspace || !request.evidenceDir || !request.projectId || !request.runId) throw new Error('workspace, evidence, project id, and run id are required');
    const archiveDir = join(request.evidenceDir, 'platform', request.runId);
    await mkdir(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, 'workspace.tar.gz');
    await createWorkspaceArchive(request.workspace, archivePath);
    const offer = await this.selectOffer(request.signal);
    const artifactId = await this.uploadArtifact(archivePath, request.signal);
    const timeoutMs = request.timeoutMs > 0 ? request.timeoutMs : this.timeoutMs;
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const jobId = await this.createJob(offer, artifactId, request, timeoutMs, request.signal);
    const status = await this.waitForJob(jobId, timeoutMs, request.signal);
    const logs = await this.fetchLogs(jobId, request.signal);
    const finishedAt = new Date().toISOString();
    const env = buildExecutionEnv(request);
    env.REPROLENS_PLATFORM = offer.provider;
    env.REPROLENS_OFFER_ID = offer.id;
    const result: ExecutionResult = {
      runner: `${offer.provider}:${offer.gpu_type}`,
      status: status.status === 'timeout' ? 'timeout' : status.status === 'succeeded' ? 'succeeded' : 'failed',
      command: request.command,
      image: this.image,
      workDir: request.workDir,
      exitCode: status.status === 'timeout' ? -1 : status.exit_code,
      startedAt,
      finishedAt,
      durationMs: Date.now() - started,
      stdout: logs.stdout,
      stderr: logs.stderr,
      env,
      gpu: offer.vram_gb > 0,
      provider: offer.provider,
      remoteJobId: jobId,
      offerId: offer.id,
    };
    await writeRunEvidence(request, result);
    return result;
  }

  async selectOffer(signal?: AbortSignal): Promise<PlatformOffer> {
    const raw = await this.requestJSON('/v1/offers', { method: 'GET', signal });
    const offers: PlatformOffer[] = Array.isArray(raw) ? raw as PlatformOffer[] : (raw as { offers?: PlatformOffer[] }).offers ?? [];
    const filtered = offers.filter((offer) => {
      if (!offer.available) return false;
      if (this.enableGPU) {
        if (offer.vram_gb <= 0 || offer.vram_gb < this.minVRAMGB) return false;
        if (this.gpuType && offer.gpu_type.toLowerCase() !== this.gpuType.toLowerCase()) return false;
      } else if (offer.vram_gb > 0) {
        return false;
      }
      return this.maxHourlyUSD <= 0 || offer.hourly_usd <= this.maxHourlyUSD;
    });
    const candidates = filtered.length > 0 ? filtered : offers.filter((offer) => offer.available && (this.maxHourlyUSD <= 0 || offer.hourly_usd <= this.maxHourlyUSD));
    if (candidates.length === 0) throw new Error('no platform offer satisfies GPU/VRAM/price requirements');
    return candidates.sort((a, b) => a.hourly_usd === b.hourly_usd ? b.vram_gb - a.vram_gb : a.hourly_usd - b.hourly_usd)[0]!;
  }

  async uploadArtifact(archivePath: string, signal?: AbortSignal): Promise<string> {
    const data = await readFile(archivePath);
    const form = new FormData();
    form.append('file', new Blob([data], { type: 'application/gzip' }), basename(archivePath));
    const response = await fetch(`${this.baseURL}/v1/artifacts`, { method: 'POST', body: form, signal, headers: this.authHeaders() });
    const raw = await response.text();
    if (!response.ok) throw new Error(`artifact upload failed: HTTP ${response.status}: ${raw.trim().slice(0, 600)}`);
    const parsed = JSON.parse(raw) as { artifact_id?: string };
    if (!parsed.artifact_id) throw new Error('platform returned empty artifact id');
    return parsed.artifact_id;
  }

  async createJob(offer: PlatformOffer, artifactId: string, request: ExecutionRequest, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    const raw = await this.requestJSON('/v1/jobs', {
      method: 'POST',
      signal,
      body: JSON.stringify({
        offer_id: offer.id,
        artifact_id: artifactId,
        command: request.command,
        image: this.image,
        gpu: offer.vram_gb > 0,
        timeout_seconds: Math.ceil(timeoutMs / 1000),
        env: { REPROLENS_SEED: String(request.seed), MPLBACKEND: 'Agg' },
      }),
    });
    const jobId = (raw as { job_id?: string }).job_id;
    if (!jobId) throw new Error('platform returned empty job id');
    return jobId;
  }

  async waitForJob(jobId: string, timeoutMs: number, signal?: AbortSignal): Promise<{ status: string; exit_code: number }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const raw = await this.requestJSON(`/v1/jobs/${jobId}`, { method: 'GET', signal }) as { status?: string; exit_code?: number };
      const status = (raw.status ?? '').toLowerCase();
      if (['succeeded', 'failed', 'cancelled', 'canceled', 'timeout'].includes(status)) {
        return { status, exit_code: raw.exit_code ?? -1 };
      }
      await sleep(this.pollIntervalMs, signal);
    }
    return { status: 'timeout', exit_code: -1 };
  }

  async fetchLogs(jobId: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; exit_code: number }> {
    return this.requestJSON(`/v1/jobs/${jobId}/logs`, { method: 'GET', signal }) as Promise<{ stdout: string; stderr: string; exit_code: number }>;
  }

  private async requestJSON(path: string, options: RequestInit): Promise<unknown> {
    const response = await fetch(`${this.baseURL}${path}`, {
      ...options,
      headers: { ...this.authHeaders(), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers ?? {}) },
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`platform request ${path} failed: HTTP ${response.status}: ${raw.trim().slice(0, 600)}`);
    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`decode platform response: ${(error as Error).message}`);
    }
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('platform request aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('platform request aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
