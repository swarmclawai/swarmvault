// First-party helper module referenced by app.ts. Having two first-party
// files with a real import edge makes the graph-guided benchmark numbers
// more meaningful than a single-file corpus would.

/**
 * Produce a greeting string. Returned separately from `main` so the
 * compiler graph has a symbol-to-symbol import relationship to analyse.
 */
export function greet(target: string): string {
  return `Hello from the large-repo worked example, ${target}!`;
}
