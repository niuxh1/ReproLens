#!/usr/bin/env node
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig, localRunnerAllowed, type Config } from './config.js';
import { applyRuntimeConfig, RuntimeSettings } from './runtime.js';
import { HeuristicAnalyzer } from './agent/heuristic.js';
import { OpenAICompatibleAnalyzer } from './agent/openai.js';
import { FallbackAnalyzer } from './agent/fallback.js';
import { CommandAgent } from './codeagent/command.js';
import { materializeDemo } from './demo.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { SqliteStore } from './store/sqlite-store.js';
import { buildServer } from './httpapi/server.js';
import { LocalRunner } from './tools/local-runner.js';
import { DockerRunner } from './tools/docker-runner.js';
import { SSHRunner } from './tools/ssh-runner.js';
import { Workspace } from './tools/workspace.js';
import type { Runner } from './tools/runner.js';
import type { Project } from './domain/types.js';

const VERSION = '0.2.0';
const program = new Command();

program.name('reprolens').description('Claim-driven scientific reproduction agent').version(VERSION);

program.command('serve').description('start the Fastify control API and dashboard').action(async () => {
  const config = await loadConfig(envFile());
  const built = await buildOrchestrator(config);
  const settings = new RuntimeSettings(config, config.dataDir);
  await settings.loadPersisted();
  applyRuntimeConfig(built.orchestrator, settings.current, (message) => console.log(message));
  const server = await buildServer(built.orchestrator, config.dataDir, settings);
  const { host, port } = parseAddress(config.addr);
  const close = async (): Promise<void> => {
    await server.close();
    await built.close();
  };
  process.once('SIGINT', () => { void close().then(() => process.exit(0)); });
  await server.listen({ host, port });
  console.log(`ReproLens listening on http://${config.addr}`);
});

program.command('demo').description('run the built-in reproduction demo').option('--auto-approve', 'approve the proposed patch automatically').action(async (options: { autoApprove?: boolean }) => {
  const config = await loadConfig(envFile());
  await runDemo(config, Boolean(options.autoApprove));
});

program.command('ssh-demo').description('probe SSH deployment against a remote host').option('--host <host>', 'SSH target', process.env.REPROLENS_SSH_HOST ?? 'asus@127.0.0.1').option('--port <port>', 'SSH port', process.env.REPROLENS_SSH_PORT ?? '2222').option('--identity <path>', 'SSH identity file', process.env.REPROLENS_SSH_IDENTITY ?? '').option('--base-dir <path>', 'remote base directory', process.env.REPROLENS_SSH_BASE_DIR ?? '/home/asus/reprolens-test').option('--gpu', 'enable GPU environment variables on the remote host').action(async (options: { host: string; port: string; identity: string; baseDir: string; gpu?: boolean }) => {
  const config = await loadConfig(envFile());
  await runSSHDemo(config, options.host, Number(options.port), options.identity, options.baseDir, Boolean(options.gpu));
});

program.command('check-llm').description('verify the configured OpenAI-compatible endpoint').action(async () => {
  const config = await loadConfig(envFile());
  if (!config.llm.baseURL) throw new Error('REPROLENS_LLM_BASE_URL is not configured');
  const analyzer = new OpenAICompatibleAnalyzer({ baseURL: config.llm.baseURL, apiKey: config.llm.apiKey, model: config.llm.model, timeoutMs: config.llm.timeoutMs, vision: config.llm.vision });
  const paper = { title: 'Probe', text: '# Probe\n\nClaim C1: accuracy = 0.81 (tolerance ±0.01).', source_path: 'probe.md', sha256: '', claims: [], parsed_at: new Date().toISOString() };
  const claims = await analyzer.extractClaims(paper, { root: '', files: [], command_candidates: [], scanned_at: new Date().toISOString() });
  console.log(`LLM OK: ${config.llm.baseURL} / ${config.llm.model}`);
  console.log(JSON.stringify(claims, null, 2));
});

program.command('version').description('print the version').action(() => console.log(`ReproLens ${VERSION}`));

program.parseAsync(process.argv).catch((error: Error) => {
  console.error(`reprolens: ${error.message}`);
  process.exitCode = 1;
});

function envFile(): string { return process.env.REPROLENS_ENV_FILE ?? '.env'; }

async function buildOrchestrator(config: Config): Promise<{ orchestrator: Orchestrator; close: () => Promise<void> }> {
  await mkdir(config.dataDir, { recursive: true });
  const store = new SqliteStore(join(config.dataDir, 'reprolens.db'));
  const analyzer = buildAnalyzer(config);
  const runner = buildRunner(config);
  const orchestrator = new Orchestrator(store, analyzer, runner, config.dataDir);
  if (config.codeAgent.type !== 'none') {
    orchestrator.setCodeAgent(new CommandAgent({ command: config.codeAgent.command, appendPrompt: true, runAcceptance: config.codeAgent.runAcceptance, timeoutMs: config.codeAgent.timeoutMs }));
    console.log(`code agent enabled: ${config.codeAgent.type} (${config.codeAgent.command})`);
  }
  return { orchestrator, close: () => store.close() };
}

function buildAnalyzer(config: Config) {
  const heuristic = new HeuristicAnalyzer();
  if (!config.llm.baseURL) {
    console.log('LLM disabled; using deterministic heuristic analyzer');
    return heuristic;
  }
  try {
    const remote = new OpenAICompatibleAnalyzer({ baseURL: config.llm.baseURL, apiKey: config.llm.apiKey, model: config.llm.model, timeoutMs: config.llm.timeoutMs, vision: config.llm.vision });
    console.log(`LLM analyzer: ${config.llm.model} (${config.llm.baseURL}), heuristic fallback enabled`);
    return new FallbackAnalyzer(remote, heuristic, (error) => console.log(`LLM fallback: ${error.message}`));
  } catch (error) {
    console.log(`LLM configuration rejected, using heuristic analyzer: ${(error as Error).message}`);
    return heuristic;
  }
}

function buildRunner(config: Config): Runner {
  switch (config.runner) {
    case 'local':
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

async function runDemo(config: Config, autoApprove: boolean): Promise<void> {
  const built = await buildOrchestrator(config);
  try {
    const paths = await materializeDemo(config.dataDir, `cli_demo_${Date.now()}`);
    let project = await built.orchestrator.createProject({ name: 'CLI accuracy reproduction demo', ...paths, budget: { max_runs: 3, max_seconds: 60, max_patches: 2 } });
    project = await built.orchestrator.start(project.id);
    if (!project.claims?.length) throw new Error('demo produced no claims');
    project = await built.orchestrator.selectClaims(project.id, [project.claims[0]!.claim_id]);
    project = await built.orchestrator.confirmPlan(project.id);
    if (project.state === 'AWAITING_PATCH' && project.patch) {
      console.log('Patch proposal:');
      console.log(project.patch.diff);
      let approved = autoApprove;
      if (!autoApprove) {
        const rl = createInterface({ input, output });
        const answer = await rl.question('Apply this patch and retry? [y/N] ');
        rl.close();
        approved = /^y(es)?$/i.test(answer.trim());
      }
      if (!approved) {
        console.log(`Workflow paused at ${project.state}. Project: ${project.id}`);
        return;
      }
      project = await built.orchestrator.approvePatch(project.id, 'cli-user');
    }
    printProjectResult(project);
  } finally {
    await built.close();
  }
}

async function runSSHDemo(config: Config, host: string, port: number, identity: string, baseDir: string, gpu: boolean): Promise<void> {
  let resolvedIdentity = identity;
  if (!resolvedIdentity) resolvedIdentity = resolve('.work', 'ssh', 'reprolens_wsl_rsa');
  const workspace = await Workspace.create(config.dataDir, `ssh_probe_${Date.now()}`);
  await writeFile(join(workspace.root, 'probe.py'), "print('SSH_DEPLOY_OK')\n", 'utf8');
  await writeFile(join(workspace.root, 'probe.sh'), '#!/usr/bin/env bash\nset -euo pipefail\npython3 probe.py\nnvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || true\n', 'utf8');
  const runner = new SSHRunner({ host, port, identity: resolvedIdentity, baseDir, enableGPU: gpu });
  const result = await runner.execute({ projectId: 'ssh_probe', runId: 'run_1', workspace: workspace.root, evidenceDir: workspace.evidenceDir, command: 'bash probe.sh', workDir: '.', seed: 42, timeoutMs: 60_000 });
  console.log(`SSH deployment status: ${result.status}`);
  console.log(`SSH host: ${host}:${port}`);
  console.log(`GPU enabled: ${result.gpu}`);
  console.log(`stdout:\n${result.stdout}`);
  if (result.stderr) console.log(`stderr:\n${result.stderr}`);
  if (result.status !== 'succeeded') throw new Error('SSH deployment probe failed');
}

function printProjectResult(project: Project): void {
  console.log(`Project:   ${project.id}`);
  console.log(`State:     ${project.state}`);
  if (project.verification) console.log(`Verdict:   ${project.verification.verdict} (${project.verification.metric}: observed ${project.verification.observed}, expected ${project.verification.expected})`);
  if (project.verification?.rule) console.log(`Rule:      ${project.verification.rule}`);
  console.log(`Runs:      ${project.runs?.length ?? 0}`);
  if (project.report?.package_path) console.log(`Report:    ${project.report.package_path}`);
  if (project.error) console.log(`Error:     ${project.error}`);
}

function parseAddress(address: string): { host: string; port: number } {
  const separator = address.lastIndexOf(':');
  if (separator < 0) throw new Error(`invalid address ${address}`);
  return { host: address.slice(0, separator) || '127.0.0.1', port: Number(address.slice(separator + 1)) };
}
