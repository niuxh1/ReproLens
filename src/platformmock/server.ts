import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';

export interface PlatformMock {
  url: string;
  close: () => Promise<void>;
}

interface Job {
  id: string;
  offerId: string;
  command: string;
  image: string;
  gpu: boolean;
  polls: number;
  status: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  createdAt: string;
}

const offers = [
  { id: 'colab-cpu', provider: 'colab', gpu_type: 'CPU', vram_gb: 0, hourly_usd: 0, available: true },
  { id: 'colab-t4', provider: 'colab', gpu_type: 'T4', vram_gb: 16, hourly_usd: 0, available: true },
  { id: 'colab-l4', provider: 'colab', gpu_type: 'L4', vram_gb: 24, hourly_usd: 0.35, available: true },
  { id: 'colab-a100', provider: 'colab', gpu_type: 'A100', vram_gb: 40, hourly_usd: 1.2, available: true },
];

export async function startPlatformMock(options: { host?: string; port?: number } = {}): Promise<PlatformMock> {
  const app: FastifyInstance = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024 } });
  const artifacts = new Map<string, Buffer>();
  const jobs = new Map<string, Job>();
  let nextId = 0;

  app.get('/healthz', async () => ({ status: 'ok', service: 'mock-colab' }));
  app.get('/v1/offers', async () => ({ offers }));
  app.post('/v1/artifacts', async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: { message: 'missing file field' } });
    const data = await file.toBuffer();
    nextId += 1;
    const id = `artifact_${nextId}`;
    artifacts.set(id, data);
    return reply.code(201).send({ artifact_id: id });
  });
  app.post('/v1/jobs', async (request, reply) => {
    const body = request.body as { offer_id?: string; artifact_id?: string; command?: string; image?: string; gpu?: boolean };
    const data = body.artifact_id ? artifacts.get(body.artifact_id) : undefined;
    if (!data) return reply.code(404).send({ error: { message: 'artifact not found' } });
    const simulated = await simulate(data);
    nextId += 1;
    const id = `job_${nextId}`;
    jobs.set(id, {
      id, offerId: body.offer_id ?? '', command: body.command ?? '', image: body.image ?? '', gpu: body.gpu ?? false,
      polls: 0, status: simulated.status, exitCode: simulated.exitCode, stdout: simulated.stdout, stderr: simulated.stderr,
      createdAt: new Date().toISOString(),
    });
    return reply.code(201).send({ job_id: id, status: 'queued' });
  });
  app.get<{ Params: { id: string } }>('/v1/jobs/:id', async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) return reply.code(404).send({ error: { message: 'job not found' } });
    job.polls += 1;
    return { job_id: job.id, status: job.polls < 2 ? 'running' : job.status, exit_code: job.exitCode, created_at: job.createdAt, updated_at: new Date().toISOString() };
  });
  app.get<{ Params: { id: string } }>('/v1/jobs/:id/logs', async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) return reply.code(404).send({ error: { message: 'job not found' } });
    return { stdout: job.stdout, stderr: job.stderr, exit_code: job.exitCode, status: job.status };
  });

  await app.listen({ port: options.port ?? 0, host: options.host ?? '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('mock platform address unavailable');
  return { url: `http://127.0.0.1:${address.port}`, close: async () => { await app.close(); } };
}

async function simulate(archive: Buffer): Promise<{ stdout: string; stderr: string; status: string; exitCode: number }> {
  let content: string;
  try {
    content = await readRunScript(archive);
  } catch (error) {
    return { stdout: '', stderr: (error as Error).message, status: 'failed', exitCode: 1 };
  }
  if (content.includes('SEED = 0')) return { stdout: '', stderr: 'seed mismatch: expected 42, got 0\n', status: 'failed', exitCode: 1 };
  if (content.includes('SEED = 42')) return { stdout: 'accuracy=0.81\n', stderr: '', status: 'succeeded', exitCode: 0 };
  return { stdout: '', stderr: 'simulated runtime could not locate a supported experiment\n', status: 'failed', exitCode: 1 };
}

async function readRunScript(archive: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'reprolens-platform-artifact-'));
  const file = join(dir, 'workspace.tar.gz');
  try {
    await import('node:fs/promises').then(({ writeFile }) => writeFile(file, archive));
    await tar.x({ file, cwd: dir });
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    const entry = entries.find((item) => item.isFile() && item.name === 'run_experiment.py');
    if (!entry) throw new Error('run_experiment.py not found in uploaded artifact');
    return await readFile(join(entry.parentPath ?? dir, entry.name), 'utf8');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
