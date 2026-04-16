import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CandidateList } from "../src/components/CandidateList";
import type { ViewerCandidateRecord } from "../src/lib";

function sample(overrides: Partial<ViewerCandidateRecord> = {}): ViewerCandidateRecord {
  return {
    pageId: "candidate-1",
    title: "Candidate Alpha",
    kind: "concept",
    path: "wiki/candidates/alpha.md",
    activePath: "wiki/concepts/alpha.md",
    sourceIds: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    score: 0.8,
    ...overrides
  };
}

function render(candidates: ViewerCandidateRecord[], onBulk?: (ids: string[], action: "promote" | "archive") => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <CandidateList
        candidates={candidates}
        candidateError={null}
        busyAction=""
        onCandidateAction={vi.fn()}
        onBulkCandidateAction={onBulk}
        onOpenPage={vi.fn()}
      />
    );
  });
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    }
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("CandidateList", () => {
  it("renders an empty state when there are no candidates", () => {
    const handle = render([]);
    expect(handle.container.textContent ?? "").toContain("No candidate pages");
    handle.cleanup();
  });

  it("surfaces candidate scores", () => {
    const handle = render([sample({ score: 0.9 }), sample({ pageId: "candidate-2", title: "Beta", score: 0.4 })]);
    const text = handle.container.textContent ?? "";
    expect(text).toContain("score 0.90");
    expect(text).toContain("score 0.40");
    const alphaIndex = text.indexOf("Candidate Alpha");
    const betaIndex = text.indexOf("Beta");
    expect(alphaIndex).toBeGreaterThan(-1);
    expect(betaIndex).toBeGreaterThan(alphaIndex);
    handle.cleanup();
  });

  it("invokes the bulk callback when present", () => {
    const onBulk = vi.fn();
    const handle = render([sample(), sample({ pageId: "candidate-2", title: "Beta" })], onBulk);
    const checkbox = handle.container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(checkbox).toBeTruthy();
    act(() => {
      checkbox?.click();
    });
    const promoteButton = Array.from(handle.container.querySelectorAll<HTMLButtonElement>("button")).find(
      (btn) => btn.textContent?.trim() === "Promote all"
    );
    expect(promoteButton).toBeTruthy();
    act(() => {
      promoteButton?.click();
    });
    expect(onBulk).toHaveBeenCalled();
    handle.cleanup();
  });
});
