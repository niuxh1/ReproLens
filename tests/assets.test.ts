import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('static browser assets', () => {
  it('does not contain escaped newline markers in CSS', async () => {
    const css = await readFile('public/style.css', 'utf8');
    expect(css).not.toMatch(/\\n\./);
  });
});