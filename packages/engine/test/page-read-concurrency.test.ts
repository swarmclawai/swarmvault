import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "../src/utils.js";

/**
 * Regression test for the EMFILE bug: loadPageContents used to fire one
 * fs.readFile per vault page via an unbounded Promise.all, which blows the
 * OS open-file-handle limit once a vault has a few thousand pages. The fix
 * routes that fan-out through runWithConcurrency instead — these tests pin
 * down its concurrency cap and result-ordering contract directly.
 */
describe("runWithConcurrency", () => {
  it("never runs more than maxParallel tasks at once", async () => {
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 50 }, (_, index) => async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return index;
    });

    await runWithConcurrency(tasks, 5);

    expect(peak).toBeLessThanOrEqual(5);
  });

  it("preserves result order regardless of completion order", async () => {
    const delays = [30, 10, 20, 0, 15];
    const tasks = delays.map((delay, index) => async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return index;
    });

    const results = await runWithConcurrency(tasks, 3);

    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  it("clamps maxParallel below 1 to a single worker instead of hanging", async () => {
    const results = await runWithConcurrency(
      [async () => 1, async () => 2],
      0
    );

    expect(results).toEqual([1, 2]);
  });

  it("still processes every task when maxParallel exceeds the task count", async () => {
    const results = await runWithConcurrency(
      Array.from({ length: 3 }, (_, index) => async () => index),
      64
    );

    expect(results).toEqual([0, 1, 2]);
  });
});
