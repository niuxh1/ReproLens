import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, parseDurationMs } from '../src/config.js';

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
});

describe('configuration', () => {
  it('loads defaults and local OpenAI-compatible settings from an env file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reprolens-config-'));
    const envPath = join(dir, '.env');
    await writeFile(envPath, [
      'REPROLENS_LLM_BASE_URL=http://127.0.0.1:8788/v1',
      'REPROLENS_LLM_API_KEY=test-key',
      'REPROLENS_LLM_MODEL=deepseek-v4.1-flash',
      'REPROLENS_LLM_VISION=true',
    ].join('\n'));
    const cfg = await loadConfig(envPath);
    expect(cfg.addr).toBe('127.0.0.1:8080');
    expect(cfg.llm.baseURL).toBe('http://127.0.0.1:8788/v1');
    expect(cfg.llm.model).toBe('deepseek-v4.1-flash');
    expect(cfg.llm.vision).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('does not let an env file override process environment values', async () => {
    process.env.REPROLENS_ADDR = '127.0.0.1:9999';
    const dir = await mkdtemp(join(tmpdir(), 'reprolens-config-'));
    const envPath = join(dir, '.env');
    await writeFile(envPath, 'REPROLENS_ADDR=127.0.0.1:8080\n');
    const cfg = await loadConfig(envPath);
    expect(cfg.addr).toBe('127.0.0.1:9999');
    await rm(dir, { recursive: true, force: true });
  });

  it('requires an explicit opt-in for non-loopback control planes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reprolens-config-remote-'));
    const envPath = join(dir, '.env');
    await writeFile(envPath, 'REPROLENS_ADDR=0.0.0.0:8080\n');
    await expect(loadConfig(envPath)).rejects.toThrow(/ALLOW_REMOTE/);
    await writeFile(envPath, 'REPROLENS_ADDR=0.0.0.0:8080\nREPROLENS_ALLOW_REMOTE=true\n');
    const cfg = await loadConfig(envPath);
    expect(cfg.allowRemote).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('parses Go-style duration strings', () => {
    expect(parseDurationMs('60s')).toBe(60_000);
    expect(parseDurationMs('10m')).toBe(600_000);
    expect(parseDurationMs('2h')).toBe(7_200_000);
    expect(() => parseDurationMs('later')).toThrow(/duration/i);
  });
});
