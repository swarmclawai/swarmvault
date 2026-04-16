import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PagePreview } from "../src/components/PagePreview";
import type { ViewerPagePayload } from "../src/lib";

function samplePage(content = "# Hello\n\nThis is **markdown**."): ViewerPagePayload {
  return {
    path: "wiki/example.md",
    title: "Example Page",
    frontmatter: {
      kind: "concept",
      status: "active",
      page_id: "page-123",
      project_ids: ["alpha"],
      source_ids: ["src-1", "src-2"],
      node_ids: ["node-1"],
      tags: ["alpha", "beta"]
    },
    content,
    assets: []
  };
}

function render(page: ViewerPagePayload | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <PagePreview activePage={page} pageError={null} backlinkPages={[]} relatedPages={[]} graphPageLinks={[]} onOpenPage={vi.fn()} />
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

describe("PagePreview", () => {
  it("shows the empty state when no page is active", () => {
    const handle = render(null);
    expect(handle.container.textContent ?? "").toContain("Open a search result");
    handle.cleanup();
  });

  it("renders markdown content and frontmatter chips", () => {
    const handle = render(samplePage());
    const text = handle.container.textContent ?? "";
    expect(text).toContain("Example Page");
    expect(text).toContain("Hello");
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text).toContain("src-1");
    handle.cleanup();
  });

  it("collapses long content and exposes a toggle", () => {
    const longContent = `${"word ".repeat(400)}`;
    const handle = render(samplePage(longContent));
    const text = handle.container.textContent ?? "";
    expect(text).toMatch(/Show all/);
    handle.cleanup();
  });
});
