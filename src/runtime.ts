import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Analyzer } from './agent/analyzer.js';
import { FallbackAnalyzer } from './agent/fallback.js';
import { HeuristicAnalyzer } from './agent/heuristic.js';
import { OpenAICompatibleAnalyzer } from './agent/openai.js';
import type { CodeAgent } from './codeagent/code-agent.js';
import { CommandAgent } from './codeagent/command.js';
import { localRunnerAllowed, mergeConfig, type Config, type ConfigPatch } from './config.js';
import type { Orchestrator } from './orchestrator/orchestrator.js';
import type { Runner } from './tools/runner.js';
import { DockerRunner } from './tools/docker-runner.js';
import { LocalRunner } from './tools/local-runner.js';
import { SSHRunner } from './tools/ssh-runner.js';

export function buildAnalyzer(config: Config, log: (message: string) => void = () => undefined): Analyzer {
  const heuristic = new HeuristicAnalyzer();
  if (!config.llm.baseURL) {
    log('LLM disabled; using deterministic heuristic analyzer');
    return heuristic;
  }
  try {
    const remote = new OpenAICompatibleAnalyzer({
      baseURL: config.llm.baseURL, apiKey: config.llm.apiKey, model: config.llm.model,
      timeoutMs: config.llm.timeoutMs, vision: config.llm.vision,
    });
    log(`LLM analyzer: ${config.llm.model} (${config.llm.baseURL}), heuristic fallback enabled`);
    return new FallbackAnalyzer(remote, heuristic, (error) => log(`LLM fallback: ${error.message}`));
  } catch (error) {
    log(`LLM configuration rejected, using heuristic analyzer: ${(error as Error).message}`);
    return heuristic;
  }
}

export function buildRunner(config: Config): Runner {
  switch (config.runner) {
    case 'local':
      if (!localRunnerAllowed(config)) throw new Error('local runner requires a loopback server address');
      return new LocalRunner(config.enableGPU);
    case 'docker':
      return new DockerRunner({ enableGPU: config.enableGPU });
    case 'ssh':
      return new SSHRunner({ host: config.remote.host, port: config.remote.port, identity: config.remote.identity, baseDir: config.remote.baseDir, enableGPU: config.enableGPU });

    case 'auto': {
      const docker = spawnSync('docker', ['--version'], { stdio: 'ignore' });
      if (docker.status === 0) return new DockerRunner({ enableGPU: config.enableGPU });
      if (!localRunnerAllowed(config)) throw new Error('docker not found and local runner is only allowed on loopback addresses');
      return new LocalRunner(config.enableGPU);
    }
  }
}

export function buildCodeAgent(config: Config): CodeAgent | null {
  if (config.codeAgent.type === 'none') return null;
  return new CommandAgent({
    command: config.codeAgent.command,
    appendPrompt: true,
    runAcceptance: config.codeAgent.runAcceptance,
    timeoutMs: config.codeAgent.timeoutMs,
  });
}

export function applyRuntimeConfig(orchestrator: Orchestrator, config: Config, log?: (message: string) => void): void {
  orchestrator.setAnalyzer(buildAnalyzer(config, log));
  orchestrator.setRunner(buildRunner(config));
  orchestrator.setCodeAgent(buildCodeAgent(config));
}

export class RuntimeSettings {
  private config: Config;

  constructor(config: Config, private readonly dataDir: string) {
    this.config = structuredClone(config);
  }

  get current(): Config { return structuredClone(this.config); }

  async loadPersisted(): Promise<Config> {
    const path = join(this.dataDir, 'settings.json');
    try {
      const raw = await readFile(path, 'utf8');
      const persisted = JSON.parse(raw) as ConfigPatch;
      this.config = mergeConfig(this.config, persisted);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return this.current;
  }

  async update(patch: ConfigPatch): Promise<Config> {
    const sanitized = sanitizePatch(this.config, patch);
    this.config = mergeConfig(this.config, sanitized);
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(join(this.dataDir, 'settings.json'), JSON.stringify(this.config, null, 2), 'utf8');
    return this.current;
  }

  publicSnapshot(): Config {
    const copy = this.current;
    copy.llm.apiKey = maskSecret(copy.llm.apiKey);
    return copy;
  }
}

function sanitizePatch(current: Config, patch: ConfigPatch): ConfigPatch {
  const next = structuredClone(patch);
  if (next.llm?.apiKey !== undefined) {
    if (!next.llm.apiKey || next.llm.apiKey.startsWith('••••')) delete next.llm.apiKey;
  }

  if (next.llm?.baseURL === '') {
    next.llm = { ...next.llm, apiKey: '', model: '' };
  }

  return next;
}

function maskSecret(secret: string): string {
  return secret ? `••••••••${secret.slice(-4)}` : '';
}
