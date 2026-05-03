import { fireEvent } from "@testing-library/dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchDashboard } from "../src/components/WorkbenchDashboard";
import type { ViewerDoctorReport } from "../src/lib";

const report: ViewerDoctorReport = {
  ok: false,
  status: "warning",
  generatedAt: "2026-04-29T20:00:00.000Z",
  rootDir: "/tmp/vault",
  version: "3.5.0",
  counts: {
    sources: 2,
    managedSources: 1,
    pages: 7,
    nodes: 12,
    edges: 18,
    approvalsPending: 1,
    candidates: 3,
    tasks: 1,
    pendingSemanticRefresh: 0
  },
  recommendations: [
    {
      id: "graph:swarmvault compile",
      label: "Fix Graph",
      summary: "Graph artifact is missing.",
      priority: "high",
      status: "error",
      sourceCheckId: "graph",
      command: "swarmvault compile",
      description: "Compile sources into graph and wiki artifacts."
    },
    {
      id: "retrieval:swarmvault retrieval doctor --repair",
      label: "Fix Retrieval",
      summary: "Retrieval stale.",
      priority: "medium",
      status: "warning",
      sourceCheckId: "retrieval",
      command: "swarmvault retrieval doctor --repair",
      description: "Rebuild retrieval artifacts.",
      safeAction: "doctor:repair"
    }
  ],
  checks: [
    { id: "workspace", label: "Workspace", status: "ok", summary: "Workspace ready." },
    { id: "graph", label: "Graph", status: "ok", summary: "Graph present." },
    {
      id: "retrieval",
      label: "Retrieval",
      status: "warning",
      summary: "Retrieval stale.",
      detail: "Manifest is older than graph.",
      actions: [{ command: "swarmvault retrieval doctor --repair", description: "Rebuild retrieval artifacts." }]
    },
    {
      id: "migration",
      label: "Migration",
      status: "warning",
      summary: "Migration preview available.",
      actions: [{ command: "swarmvault migrate --dry-run", description: "Preview migration changes." }]
    },
    {
      id: "review",
      label: "Review Queues",
      status: "warning",
      summary: "Approvals need review.",
      actions: [{ command: "swarmvault review list", description: "Inspect staged approval bundles." }]
    },
    { id: "watch", label: "Watch", status: "ok", summary: "No pending refresh entries." }
  ],
  repaired: []
};

function renderDashboard() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onRepair = vi.fn().mockResolvedValue({ repaired: ["retrieval"] });
  const onCapture = vi.fn().mockResolvedValue({ sourceId: "clip-1", title: "Example Article" });
  const onBuildContext = vi.fn().mockResolvedValue({ pack: { id: "context-1" } });
  const onStartTask = vi.fn().mockResolvedValue({ id: "task-1", title: "Ship the release" });
  act(() => {
    root.render(
      <WorkbenchDashboard
        doctorReport={report}
        busyAction=""
        actionError={null}
        onRepair={onRepair}
        onCapture={onCapture}
        onBuildContext={onBuildContext}
        onStartTask={onStartTask}
      />
    );
  });
  return {
    container,
    onRepair,
    onCapture,
    onBuildContext,
    onStartTask,
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

describe("WorkbenchDashboard", () => {
  it("summarizes doctor counts and triggers workbench actions", async () => {
    const handle = renderDashboard();
    const text = handle.container.textContent ?? "";
    expect(text).toContain("Health warning");
    expect(text).toContain("Sources 2");
    expect(text).toContain("Managed 1");
    expect(text).toContain("Review 1");
    expect(text).toContain("Recommended Next Actions");
    expect(text).toContain("Fix Graph");
    expect(text).toContain("Fix Retrieval");
    expect(text).toContain("Manifest is older than graph.");
    expect(text).toContain("swarmvault retrieval doctor --repair");
    expect(text).toContain("swarmvault migrate --dry-run");
    expect(text).toContain("swarmvault review list");
    expect(text).toContain("Watch");

    const captureUrl = handle.container.querySelector<HTMLInputElement>('input[aria-label="Capture URL"]');
    const captureTitle = handle.container.querySelector<HTMLInputElement>('input[aria-label="Capture title"]');
    const captureText = handle.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Capture text"]');
    const captureTags = handle.container.querySelector<HTMLInputElement>('input[aria-label="Capture tags"]');
    const captureMode = handle.container.querySelector<HTMLSelectElement>('select[aria-label="Capture mode"]');
    const goal = handle.container.querySelector<HTMLInputElement>('input[aria-label="Agent goal"]');
    const target = handle.container.querySelector<HTMLInputElement>('input[aria-label="Agent target"]');
    const budget = handle.container.querySelector<HTMLInputElement>('input[aria-label="Token budget"]');
    expect(captureUrl).toBeTruthy();
    expect(captureTitle).toBeTruthy();
    expect(captureText).toBeTruthy();
    expect(captureTags).toBeTruthy();
    expect(captureMode).toBeTruthy();
    expect(goal).toBeTruthy();
    expect(target).toBeTruthy();
    expect(budget).toBeTruthy();

    await act(async () => {
      fireEvent.input(captureUrl!, { target: { value: "https://example.com/article" } });
      fireEvent.input(captureTitle!, { target: { value: "Example Article" } });
      fireEvent.input(captureText!, { target: { value: "important excerpt" } });
      fireEvent.input(captureTags!, { target: { value: "research, launch" } });
      fireEvent.change(captureMode!, { target: { value: "inbox" } });
    });
    const captureButton = Array.from(handle.container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Capture"
    );
    await act(async () => {
      captureButton?.click();
    });
    expect(handle.onCapture).toHaveBeenCalledWith({
      url: "https://example.com/article",
      title: "Example Article",
      selectionText: "important excerpt",
      tags: ["research", "launch"],
      sourceMode: "inbox"
    });
    expect(handle.container.textContent ?? "").toContain("Captured Example Article");

    await act(async () => {
      fireEvent.input(goal!, { target: { value: "Ship the release" } });
      fireEvent.input(target!, { target: { value: "packages/engine" } });
      fireEvent.input(budget!, { target: { value: "12000" } });
    });
    const packButton = Array.from(handle.container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Build Pack"
    );
    await act(async () => {
      packButton?.click();
    });
    expect(handle.onBuildContext).toHaveBeenCalledWith({
      goal: "Ship the release",
      target: "packages/engine",
      budgetTokens: 12000
    });
    const taskButton = Array.from(handle.container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Start Task"
    );
    await act(async () => {
      taskButton?.click();
    });
    expect(handle.onStartTask).toHaveBeenCalledWith({
      goal: "Ship the release",
      target: "packages/engine",
      budgetTokens: 12000
    });
    expect(handle.container.textContent ?? "").toContain("Started task task-1");

    const repairButton = Array.from(handle.container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Repair"
    );
    await act(async () => {
      repairButton?.click();
    });
    expect(handle.onRepair).toHaveBeenCalled();
    expect(handle.container.textContent ?? "").toContain("Repaired retrieval");
    handle.cleanup();
  });
});
