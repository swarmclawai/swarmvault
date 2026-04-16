import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "../src/components/CommandPalette";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function renderPalette(commands: { id: string; label: string; run: () => void }[], onClose = vi.fn()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<CommandPalette open commands={commands} onClose={onClose} />);
  });
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    }
  };
}

describe("CommandPalette", () => {
  it("renders all commands when query is empty", () => {
    const handle = renderPalette([
      { id: "a", label: "Apple", run: vi.fn() },
      { id: "b", label: "Banana", run: vi.fn() }
    ]);
    const text = handle.container.textContent ?? "";
    expect(text).toContain("Apple");
    expect(text).toContain("Banana");
    handle.cleanup();
  });

  it("invokes the handler when a command is clicked", () => {
    const apple = vi.fn();
    const onClose = vi.fn();
    const handle = renderPalette(
      [
        { id: "a", label: "Apple", run: apple },
        { id: "b", label: "Banana", run: vi.fn() }
      ],
      onClose
    );
    const button = handle.container.querySelector("button.palette-item") as HTMLButtonElement | null;
    expect(button).toBeTruthy();
    act(() => {
      button?.click();
    });
    expect(apple).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    handle.cleanup();
  });

  it("shows an empty state when no commands match", () => {
    const handle = renderPalette([{ id: "a", label: "Apple", run: vi.fn() }]);
    const input = handle.container.querySelector(".palette-input") as HTMLInputElement | null;
    expect(input).toBeTruthy();
    // React tracks the input's "previous value" internally, so to trigger
    // onChange in jsdom we need the native value setter, then dispatch input.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      if (!input || !setter) return;
      setter.call(input, "zzz");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(handle.container.textContent ?? "").toContain("No matching commands");
    handle.cleanup();
  });
});
