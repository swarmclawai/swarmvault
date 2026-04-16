import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ThemeChoice, useTheme } from "../src/hooks/useTheme";
import { useUndoBuffer } from "../src/hooks/useUndoBuffer";

function ThemeProbe({ onChange }: { onChange: (api: ReturnType<typeof useTheme>) => void }) {
  const api = useTheme();
  onChange(api);
  return null;
}

function UndoProbe({ onChange }: { onChange: (api: ReturnType<typeof useUndoBuffer>) => void }) {
  const api = useUndoBuffer(60_000);
  onChange(api);
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("useTheme", () => {
  it("applies and persists a theme choice", () => {
    let capture: ReturnType<typeof useTheme> | null = null;
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => {
      root.render(
        <ThemeProbe
          onChange={(api) => {
            capture = api;
          }}
        />
      );
    });
    expect(capture?.theme).toBe("system");
    act(() => {
      capture?.setTheme("dark");
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem("swarmvault.viewer.theme")).toBe("dark");
    act(() => root.unmount());
  });

  it("removes the attribute when set to system", () => {
    let capture: ReturnType<typeof useTheme> | null = null;
    const root = createRoot(document.createElement("div"));
    act(() => {
      root.render(
        <ThemeProbe
          onChange={(api) => {
            capture = api;
          }}
        />
      );
    });
    act(() => capture?.setTheme("light"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    act(() => capture?.setTheme("system" as ThemeChoice));
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
    act(() => root.unmount());
  });
});

describe("useUndoBuffer", () => {
  it("captures the latest entry and supports undo", async () => {
    let capture: ReturnType<typeof useUndoBuffer> | null = null;
    const root = createRoot(document.createElement("div"));
    act(() => {
      root.render(
        <UndoProbe
          onChange={(api) => {
            capture = api;
          }}
        />
      );
    });
    const undo = vi.fn();
    act(() => {
      capture?.push("Did a thing", undo);
    });
    expect(capture?.entry?.label).toBe("Did a thing");
    await act(async () => {
      await capture?.performUndo();
    });
    expect(undo).toHaveBeenCalled();
    expect(capture?.entry).toBeNull();
    act(() => root.unmount());
  });
});
