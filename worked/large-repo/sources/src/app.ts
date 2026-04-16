// First-party entry point for the large-repo worked example. The point of
// this file is to give SwarmVault a small, realistic import graph so the
// graph-enrichment and similarity passes have something to chew on.
import { greet } from "./utils.js";

/**
 * Print the greeting produced by the helper module. Kept tiny because the
 * worked example exists to exercise the benchmark-by-class reporting, not
 * to demonstrate interesting business logic.
 */
export function main(): string {
  return greet("SwarmVault");
}
