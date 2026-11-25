import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeuristicAnalyzer } from '../src/agent/heuristic.js';
import { FallbackAnalyzer } from '../src/agent/fallback.js';
import { OpenAICompatibleAnalyzer } from '../src/agent/openai.js';
import type { Analyzer } from '../src/agent/analyzer.js';
import type { Claim, Diagnosis, ExperimentPlan, Paper, RepoSummary, Run } from '../src/domain/types.js';

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function paper(text: string): Paper {
  return { title: 'test', text, source_path: 'paper.md', sha256: 'abc', claims: [], parsed_at: new Date().toISOString() };
}

function repo(readme: string): RepoSummary {
  return { root: '.', readme, files: [], command_candidates: [], scanned_at: new Date().toISOString() };
}

describe('heuristic analyzer', () => {
  it('extracts claims with metric, tolerance, and source line', async () => {
    const analyzer = new HeuristicAnalyzer();
    const claims = await analyzer.extractClaims(paper([
      '# ReproLens Demo Paper',
      '',
      'Claim C1: The classifier achieves accuracy = 0.81 (tolerance ±0.01) on the test split.',
      'Unrelated text with 1576 participants.',
    ].join('\n')), repo(''));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      claim_id: 'C1', metric: 'accuracy', expected_value: 0.81,
      tolerance: { abs: 0.01, rel: 0 }, source: { line: 3 },
    });
  });

  it('builds a plan from README commands and infers the seed', async () => {
    const analyzer = new HeuristicAnalyzer();
    const claim: Claim = { claim_id: 'C1', text: 'accuracy 0.81', metric: 'accuracy', expected_value: 0.81, tolerance: { abs: 0.01, rel: 0 }, source: { path: 'paper.md', line: 1 }, selected: true };
    const plan = await analyzer.buildPlan(claim, paper(''), repo('Run:\n\n```bash\npython run_experiment.py --seed 42 --data data.csv\n```\n'));
    expect(plan.command).toBe('python run_experiment.py --seed 42 --data data.csv');
    expect(plan.seed).toBe(42);
    expect(plan.image).toBe('python:3.11-slim');
    expect(plan.metric_source.pattern).toContain('accuracy');
  });

  it('diagnoses seed mismatch and produces a minimal diff', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reprolens-agent-'));
    dirs.push(dir);
    await writeFile(join(dir, 'run_experiment.py'), "import sys\nSEED = 0\nprint('accuracy=0.50')\n");
    const run: Run = { run_id: 'run_1', attempt: 1, runner: 'local', command: 'python run_experiment.py --seed 42', work_dir: '.', status: 'failed', exit_code: 1, started_at: new Date().toISOString(), finished_at: new Date().toISOString(), duration_ms: 1, stderr: 'seed mismatch: expected 42, got 0\n', env: { REPROLENS_SEED: '42' } };
    const diagnosis = await new HeuristicAnalyzer().diagnose(run, repo(''), dir);
    expect(diagnosis.failure_class).toBe('seed_mismatch');
    expect(diagnosis.patch_diff).toContain('-SEED = 0');
    expect(diagnosis.patch_diff).toContain('+SEED = 42');
    expect(diagnosis.confidence).toBe('high');
  });
});

describe('fallback analyzer', () => {
  it('uses the secondary analyzer when the primary fails or omits a patch', async () => {
    const primary: Analyzer = {
      extractClaims: async () => { throw new Error('offline'); },
      buildPlan: async () => { throw new Error('offline'); },
      diagnose: async () => ({ failure_class: 'seed_mismatch', root_cause: 'no patch', confidence: 'low' }),
    };
    const secondary: Analyzer = {
      extractClaims: async () => [{ claim_id: 'C1', text: 'x', metric: 'accuracy', expected_value: 0.8, tolerance: { abs: 0.01, rel: 0 }, source: { path: 'paper', line: 1 }, selected: false }],
      buildPlan: async () => ({ id: 'p', claim_id: 'C1', command: 'python run.py', image: 'python:3.11-slim', work_dir: '.', seed: 42, expected_metric: 'accuracy', expected_value: 0.8, tolerance: { abs: 0.01, rel: 0 }, metric_source: { kind: 'stdout_regex', pattern: 'accuracy=([0-9.]+)' }, confirmed: false }),
      diagnose: async () => ({ failure_class: 'seed_mismatch', root_cause: 'seed mismatch', confidence: 'high', patch_diff: '--- a/run.py\n+++ b/run.py\n@@ -1 +1 @@\n-SEED = 0\n+SEED = 42\n' }),
    };
    const analyzer = new FallbackAnalyzer(primary, secondary, () => undefined);
    expect(await analyzer.extractClaims(paper(''), repo(''))).toHaveLength(1);
    expect((await analyzer.buildPlan({} as Claim, paper(''), repo(''))).command).toBe('python run.py');
    expect((await analyzer.diagnose({} as Run, repo(''), '')).patch_diff).toContain('+SEED = 42');
  });
});

describe('OpenAI-compatible analyzer', () => {
  it('uses the compatible chat endpoint, bearer key, and model', async () => {
    let called = false;
    const server = createServer((request, response) => {
      called = true;
      expect(request.url).toBe('/v1/chat/completions');
      expect(request.headers.authorization).toBe('Bearer test-key');
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const parsed = JSON.parse(body) as { model: string };
        expect(parsed.model).toBe('deepseek-v4.1-flash');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ claims: [{ claim_id: 'C1', text: 'accuracy 0.81', metric: 'accuracy', expected_value: 0.81, tolerance: { abs: 0.01, rel: 0 }, source: { line: 3, quote: 'accuracy = 0.81' } }] }) } }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');
    const analyzer = new OpenAICompatibleAnalyzer({ baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-key', model: 'deepseek-v4.1-flash', timeoutMs: 5000 });
    const claims = await analyzer.extractClaims(paper('Claim C1: accuracy = 0.81'), repo(''));
    expect(called).toBe(true);
    expect(claims[0]?.claim_id).toBe('C1');
  });

  it('retries without response_format on 400', async () => {
    let attempts = 0;
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        attempts += 1;
        const parsed = JSON.parse(body) as { response_format?: unknown };
        if (attempts === 1) {
          expect(parsed.response_format).toBeTruthy();
          response.statusCode = 400;
          response.end('response_format unsupported');
          return;
        }
        expect(parsed.response_format).toBeUndefined();
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: '{"claims":[{"claim_id":"C1","text":"accuracy 0.81","metric":"accuracy","expected_value":0.81,"tolerance":{"abs":0.01},"source":{"line":1}}]}' } }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');
    const analyzer = new OpenAICompatibleAnalyzer({ baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'k', model: 'm', timeoutMs: 5000 });
    expect(await analyzer.extractClaims(paper('accuracy 0.81'), repo(''))).toHaveLength(1);
    expect(attempts).toBe(2);
  });

  it('rejects malformed claim JSON', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');
    const analyzer = new OpenAICompatibleAnalyzer({ baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'k', model: 'm', timeoutMs: 5000 });
    await expect(analyzer.extractClaims(paper('accuracy 0.81'), repo(''))).rejects.toThrow(/parse claims JSON/);
  });
});
