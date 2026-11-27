import type { Claim, Paper } from '../domain/types.js';

export interface ClaimProvenanceResult {
  status: 'verified' | 'unverified' | 'mismatch';
  page_number?: number;
  reason?: string;
}

export function verifyClaimProvenance(claim: Claim, paper: Paper): ClaimProvenanceResult {
  const quote = normalize(claim.source.quote ?? '');
  if (!quote) return { status: 'unverified', reason: 'claim has no source quote' };

  const pages = paper.pages ?? [];
  if (claim.source.page_number !== undefined) {
    const page = pages.find((candidate) => candidate.page_number === claim.source.page_number);
    if (!page) return { status: 'mismatch', reason: `cited page ${claim.source.page_number} does not exist` };
    if (!normalize(page.text).includes(quote)) {
      return { status: 'mismatch', page_number: page.page_number, reason: 'source quote was not found on the cited page' };
    }
    return { status: 'verified', page_number: page.page_number };
  }

  const matchingPage = pages.find((page) => normalize(page.text).includes(quote));
  if (matchingPage) return { status: 'verified', page_number: matchingPage.page_number };
  if (normalize(paper.text).includes(quote)) return { status: 'verified', reason: 'source quote matched extracted paper text' };
  return { status: 'mismatch', reason: 'source quote was not found in the paper text or page images' };
}

export function annotateClaimProvenance(claims: Claim[], paper: Paper): Claim[] {
  return claims.map((claim) => {
    const result = verifyClaimProvenance(claim, paper);
    return {
      ...claim,
      source: {
        ...claim.source,
        provenance: result.status,
        ...(result.page_number !== undefined ? { page_number: result.page_number } : {}),
        ...(result.reason ? { provenance_reason: result.reason } : {}),
      },
    };
  });
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}