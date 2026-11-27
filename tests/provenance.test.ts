import { describe, expect, it } from 'vitest';
import { verifyClaimProvenance } from '../src/tools/provenance.js';
import type { Claim, Paper } from '../src/domain/types.js';

function paper(): Paper {
  return {
    title: 'Provenance paper',
    text: 'We report accuracy 0.81 on the benchmark.',
    source_path: 'paper.pdf',
    sha256: 'abc',
    claims: [],
    parsed_at: '2026-11-27T00:00:00.000Z',
    pages: [
      { page_number: 1, text: 'Introduction and method.', caption_candidates: [] },
      { page_number: 2, text: 'We report accuracy 0.81 on the benchmark.', caption_candidates: ['Table 2'] },
    ],
  };
}

function claim(quote: string, page?: number): Claim {
  return {
    claim_id: 'C1', text: 'accuracy 0.81', metric: 'accuracy', expected_value: 0.81,
    tolerance: { abs: 0.01, rel: 0 }, selected: false,
    source: { path: 'paper.pdf', line: 1, quote, ...(page === undefined ? {} : { page_number: page }) },
  };
}

describe('claim provenance', () => {
  it('finds a normalized quote and records its PDF page', () => {
    const result = verifyClaimProvenance(claim('accuracy   0.81', 2), paper());
    expect(result).toMatchObject({ status: 'verified', page_number: 2 });
  });

  it('rejects a quote that does not occur in the cited paper', () => {
    const result = verifyClaimProvenance(claim('accuracy 0.99', 2), paper());
    expect(result.status).toBe('mismatch');
    expect(result.reason).toContain('quote');
  });

  it('rejects a page number that does not exist', () => {
    const result = verifyClaimProvenance(claim('accuracy 0.81', 9), paper());
    expect(result.status).toBe('mismatch');
    expect(result.reason).toContain('page');
  });

  it('keeps claims without a quote as unverified instead of silently trusting them', () => {
    const result = verifyClaimProvenance(claim(''), paper());
    expect(result.status).toBe('unverified');
  });
});