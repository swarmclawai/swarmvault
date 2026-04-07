import type { SourceClaim } from "./types.js";

export function nodeConfidence(sourceCount: number): number {
  return Math.min(0.5 + sourceCount * 0.15, 0.95);
}

export function edgeConfidence(claims: SourceClaim[], conceptName: string): number {
  const lower = conceptName.toLowerCase();
  const relevant = claims.filter((c) => c.text.toLowerCase().includes(lower));
  if (!relevant.length) {
    return 0.5;
  }
  return relevant.reduce((sum, c) => sum + c.confidence, 0) / relevant.length;
}

export function conflictConfidence(claimA: SourceClaim, claimB: SourceClaim): number {
  return Math.min(claimA.confidence, claimB.confidence);
}
