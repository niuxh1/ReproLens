import { readFile } from 'node:fs/promises';
import { z } from 'zod';

export const DEFAULT_ADDR = '127.0.0.1:8080';
export const DEFAULT_DATA_DIR = './data';
export const DEFAULT_RUNNER = 'auto';
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;
export const DEFAULT_SSH_PORT = 22;
export const DEFAULT_SSH_BASE_DIR = '/tmp/reprolens';
export const DEFAULT_PLATFORM_POLL_MS = 2_000;
export const DEFAULT_PLATFORM_TIMEOUT_MS = 30 * 60_000;

export interface CodeAgentConfig {
  type: 'none' | 'claude' | 'codex' | 'gemini' | 'command';
  command: string;
  timeoutMs: number;
  runAcceptance: boolean;
}

export interface LLMConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  vision: boolean;
}

export interface RemoteConfig {
  host: string;
  port: number;
  identity: string;
  baseDir: string;
}

export interface PlatformConfig {
  baseURL: string;
  apiKey: string;
  provider: string;
  image: string;
  gpuType: string;
  minVRAMGB: number;
  maxHourlyUSD: number;
  pollIntervalMs: number;
  timeoutMs: number;
}

export interface Config {
  addr: string;
  dataDir: string;
  runner: 'auto' | 'docker' | 'local' | 'ssh' | 'colab' | 'platform';
  enableGPU: boolean;
  codeAgent: CodeAgentConfig;
  llm: LLMConfig;
  remote: RemoteConfig;
  platform: PlatformConfig;
}

type Env = Record<string, string | undefined>;

export function parseDurationMs(raw: string): number {
  const value = raw.trim();
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/i.exec(value);
  if (!match) {
    throw new Error(`invalid duration ${JSON.stringify(raw)}; use ms, s, m, or h`);
  }
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000;
  const ms = amount * factor;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`duration must be positive: ${JSON.stringify(raw)}`);
  }
  return Math.round(ms);
}

function parseBool(raw: string, key: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') return true;
  if (value === 'false' || value === '0' || value === 'no' || value === 'off') return false;
  throw new Error(`invalid ${key} ${JSON.stringify(raw)}`);
}

function parseIntValue(raw: string, key: string): number {
  const value = Number(raw.trim());
  if (!Number.isInteger(value)) throw new Error(`invalid ${key} ${JSON.stringify(raw)}`);
  return value;
}

function parseFloatValue(raw: string, key: string): number {
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) throw new Error(`invalid ${key} ${JSON.stringify(raw)}`);
  return value;
}

function parseDotEnv(text: string): Env {
  const values: Env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = withoutExport.indexOf('=');
    if (separator <= 0) continue;
    const key = withoutExport.slice(0, separator).trim();
    let value = withoutExport.slice(separator + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
}

function validateURL(raw: string, key: string): string {
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('scheme');
    return raw.replace(/\/+$/, '');
  } catch {
    throw new Error(`invalid ${key} ${JSON.stringify(raw)}`);
  }
}

const runnerSchema = z.enum(['auto', 'docker', 'local', 'ssh', 'colab', 'platform']);
const codeAgentSchema = z.enum(['none', 'claude', 'codex', 'gemini', 'command']);

export async function loadConfig(envPath = '.env'): Promise<Config> {
  let fileValues: Env = {};
  try {
    fileValues = parseDotEnv(await readFile(envPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`read env file: ${(error as Error).message}`);
    }
  }
  const get = (key: string, fallback = ''): string => {
    const processValue = process.env[key];
    if (processValue !== undefined) return processValue.trim();
    return (fileValues[key] ?? fallback).trim();
  };
  const getBool = (key: string, fallback: boolean): boolean => {
    const raw = get(key, String(fallback));
    return raw === '' ? fallback : parseBool(raw, key);
  };
  const getInt = (key: string, fallback: number): number => {
    const raw = get(key, String(fallback));
    return raw === '' ? fallback : parseIntValue(raw, key);
  };
  const getFloat = (key: string, fallback: number): number => {
    const raw = get(key, String(fallback));
    return raw === '' ? fallback : parseFloatValue(raw, key);
  };
  const getDuration = (key: string, fallback: number): number => {
    const raw = get(key, `${fallback}ms`);
    if (raw === '') return fallback;
    return parseDurationMs(raw);
  };

  const runner = runnerSchema.parse((get('REPROLENS_RUNNER', DEFAULT_RUNNER) || DEFAULT_RUNNER).toLowerCase());
  const codeAgentType = codeAgentSchema.parse((get('REPROLENS_CODE_AGENT', 'none') || 'none').toLowerCase());
  let codeAgentCommand = get('REPROLENS_CODE_AGENT_CMD', '');
  if (codeAgentType === 'claude' && !codeAgentCommand) codeAgentCommand = 'claude -p --allowedTools Read,Edit,Write,Bash';
  if (codeAgentType === 'codex' && !codeAgentCommand) codeAgentCommand = 'codex exec --approve-for-me --ephemeral';
  if (codeAgentType === 'gemini' && !codeAgentCommand) codeAgentCommand = 'gemini';
  if (codeAgentType === 'command' && !codeAgentCommand) {
    throw new Error('REPROLENS_CODE_AGENT_CMD is required for the command code agent');
  }

  const cfg: Config = {
    addr: get('REPROLENS_ADDR', DEFAULT_ADDR) || DEFAULT_ADDR,
    dataDir: get('REPROLENS_DATA_DIR', DEFAULT_DATA_DIR) || DEFAULT_DATA_DIR,
    runner,
    enableGPU: getBool('REPROLENS_ENABLE_GPU', false),
    codeAgent: {
      type: codeAgentType,
      command: codeAgentCommand,
      timeoutMs: getDuration('REPROLENS_CODE_AGENT_TIMEOUT', 10 * 60_000),
      runAcceptance: getBool('REPROLENS_CODE_AGENT_RUN_ACCEPTANCE', false),
    },
    llm: {
      baseURL: validateURL(get('REPROLENS_LLM_BASE_URL'), 'REPROLENS_LLM_BASE_URL'),
      apiKey: get('REPROLENS_LLM_API_KEY'),
      model: get('REPROLENS_LLM_MODEL'),
      timeoutMs: getDuration('REPROLENS_LLM_TIMEOUT', DEFAULT_LLM_TIMEOUT_MS),
      vision: getBool('REPROLENS_LLM_VISION', true),
    },
    remote: {
      host: get('REPROLENS_SSH_HOST'),
      port: getInt('REPROLENS_SSH_PORT', DEFAULT_SSH_PORT),
      identity: get('REPROLENS_SSH_IDENTITY'),
      baseDir: get('REPROLENS_SSH_BASE_DIR', DEFAULT_SSH_BASE_DIR) || DEFAULT_SSH_BASE_DIR,
    },
    platform: {
      baseURL: validateURL(get('REPROLENS_PLATFORM_BASE_URL'), 'REPROLENS_PLATFORM_BASE_URL'),
      apiKey: get('REPROLENS_PLATFORM_API_KEY'),
      provider: (get('REPROLENS_PLATFORM_PROVIDER', 'colab') || 'colab').toLowerCase(),
      image: get('REPROLENS_PLATFORM_IMAGE', 'python:3.11-slim') || 'python:3.11-slim',
      gpuType: get('REPROLENS_PLATFORM_GPU_TYPE'),
      minVRAMGB: getInt('REPROLENS_PLATFORM_MIN_VRAM_GB', 0),
      maxHourlyUSD: getFloat('REPROLENS_PLATFORM_MAX_HOURLY_USD', 1),
      pollIntervalMs: getDuration('REPROLENS_PLATFORM_POLL_INTERVAL', DEFAULT_PLATFORM_POLL_MS),
      timeoutMs: getDuration('REPROLENS_PLATFORM_TIMEOUT', DEFAULT_PLATFORM_TIMEOUT_MS),
    },
  };

  if (!cfg.addr) throw new Error('REPROLENS_ADDR must not be empty');
  if (!cfg.dataDir) throw new Error('REPROLENS_DATA_DIR must not be empty');
  if (cfg.remote.port < 1 || cfg.remote.port > 65535) throw new Error(`invalid REPROLENS_SSH_PORT ${cfg.remote.port}`);
  if (cfg.runner === 'ssh' && !cfg.remote.host) throw new Error('REPROLENS_SSH_HOST is required when REPROLENS_RUNNER=ssh');
  if ((cfg.runner === 'colab' || cfg.runner === 'platform') && !cfg.platform.baseURL) {
    throw new Error('REPROLENS_PLATFORM_BASE_URL is required for platform runners');
  }
  if (cfg.llm.baseURL) {
    if (!cfg.llm.apiKey) throw new Error('REPROLENS_LLM_API_KEY is required when REPROLENS_LLM_BASE_URL is set');
    if (!cfg.llm.model) throw new Error('REPROLENS_LLM_MODEL is required when REPROLENS_LLM_BASE_URL is set');
  }
  if (cfg.platform.minVRAMGB < 0 || cfg.platform.maxHourlyUSD < 0) {
    throw new Error('platform VRAM and price limits must be non-negative');
  }
  return cfg;
}

export function localRunnerAllowed(cfg: Config): boolean {
  if (cfg.runner === 'local') return true;
  const host = cfg.addr.replace(/^\[/, '').split(']')[0]!.split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}



export function validateConfig(input: Config): Config {
  const cfg = structuredClone(input);
  cfg.runner = runnerSchema.parse(String(cfg.runner).toLowerCase());
  cfg.codeAgent.type = codeAgentSchema.parse(String(cfg.codeAgent.type).toLowerCase());
  cfg.llm.baseURL = validateURL(cfg.llm.baseURL, 'REPROLENS_LLM_BASE_URL');
  cfg.platform.baseURL = validateURL(cfg.platform.baseURL, 'REPROLENS_PLATFORM_BASE_URL');
  cfg.codeAgent.command = cfg.codeAgent.command.trim();
  cfg.codeAgent.timeoutMs = Math.round(cfg.codeAgent.timeoutMs);
  cfg.llm.timeoutMs = Math.round(cfg.llm.timeoutMs);
  cfg.platform.pollIntervalMs = Math.round(cfg.platform.pollIntervalMs);
  cfg.platform.timeoutMs = Math.round(cfg.platform.timeoutMs);
  cfg.platform.provider = cfg.platform.provider.toLowerCase();
  cfg.platform.minVRAMGB = Math.round(cfg.platform.minVRAMGB);
  cfg.remote.port = Math.round(cfg.remote.port);
  cfg.remote.baseDir = cfg.remote.baseDir || DEFAULT_SSH_BASE_DIR;
  cfg.addr = cfg.addr.trim();
  cfg.dataDir = cfg.dataDir.trim();
  if (!cfg.addr) throw new Error('REPROLENS_ADDR must not be empty');
  if (!cfg.dataDir) throw new Error('REPROLENS_DATA_DIR must not be empty');
  if (cfg.remote.port < 1 || cfg.remote.port > 65535) throw new Error(`invalid REPROLENS_SSH_PORT ${cfg.remote.port}`);
  if (cfg.runner === 'ssh' && !cfg.remote.host) throw new Error('REPROLENS_SSH_HOST is required when REPROLENS_RUNNER=ssh');
  if ((cfg.runner === 'colab' || cfg.runner === 'platform') && !cfg.platform.baseURL) throw new Error('REPROLENS_PLATFORM_BASE_URL is required for platform runners');
  if (cfg.codeAgent.type === 'claude' && !cfg.codeAgent.command) cfg.codeAgent.command = 'claude -p --allowedTools Read,Edit,Write,Bash';
  if (cfg.codeAgent.type === 'codex' && !cfg.codeAgent.command) cfg.codeAgent.command = 'codex exec --approve-for-me --ephemeral';
  if (cfg.codeAgent.type === 'gemini' && !cfg.codeAgent.command) cfg.codeAgent.command = 'gemini';
  if (cfg.codeAgent.type === 'command' && !cfg.codeAgent.command) throw new Error('REPROLENS_CODE_AGENT_CMD is required for the command code agent');
  if (cfg.llm.baseURL) {
    if (!cfg.llm.apiKey) throw new Error('REPROLENS_LLM_API_KEY is required when REPROLENS_LLM_BASE_URL is set');
    if (!cfg.llm.model) throw new Error('REPROLENS_LLM_MODEL is required when REPROLENS_LLM_BASE_URL is set');
  }
  if (cfg.llm.timeoutMs <= 0 || cfg.codeAgent.timeoutMs <= 0 || cfg.platform.pollIntervalMs <= 0 || cfg.platform.timeoutMs <= 0) {
    throw new Error('timeouts and poll intervals must be positive');
  }
  if (cfg.platform.minVRAMGB < 0 || cfg.platform.maxHourlyUSD < 0) throw new Error('platform VRAM and price limits must be non-negative');
  return cfg;
}

export interface ConfigPatch {
  runner?: Config['runner'];
  enableGPU?: boolean;
  llm?: Partial<LLMConfig>;
  codeAgent?: Partial<CodeAgentConfig>;
  remote?: Partial<RemoteConfig>;
  platform?: Partial<PlatformConfig>;
  addr?: string;
  dataDir?: string;
}

export function mergeConfig(base: Config, patch: ConfigPatch): Config {
  const next = structuredClone(base);
  if (patch.addr !== undefined) next.addr = patch.addr;
  if (patch.dataDir !== undefined) next.dataDir = patch.dataDir;
  if (patch.runner !== undefined) next.runner = patch.runner;
  if (patch.enableGPU !== undefined) next.enableGPU = patch.enableGPU;
  if (patch.llm) next.llm = { ...next.llm, ...patch.llm };
  if (patch.codeAgent) next.codeAgent = { ...next.codeAgent, ...patch.codeAgent };
  if (patch.remote) next.remote = { ...next.remote, ...patch.remote };
  if (patch.platform) next.platform = { ...next.platform, ...patch.platform };
  return validateConfig(next);
}
