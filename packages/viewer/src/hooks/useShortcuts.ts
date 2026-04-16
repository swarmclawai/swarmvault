import { useEffect } from "react";

export type Shortcut = {
  key: string;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  description: string;
  handler: (event: KeyboardEvent) => void;
  allowInInput?: boolean;
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function matches(event: KeyboardEvent, shortcut: Shortcut): boolean {
  if (event.key.toLowerCase() !== shortcut.key.toLowerCase()) return false;
  const meta = event.metaKey || event.ctrlKey;
  if (Boolean(shortcut.meta) !== meta) return false;
  if (Boolean(shortcut.shift) !== event.shiftKey) return false;
  if (Boolean(shortcut.alt) !== event.altKey) return false;
  return true;
}

export function useShortcuts(shortcuts: Shortcut[]): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: KeyboardEvent) => {
      const editable = isEditableTarget(event.target);
      for (const shortcut of shortcuts) {
        if (!matches(event, shortcut)) continue;
        if (editable && !shortcut.allowInInput) continue;
        event.preventDefault();
        shortcut.handler(event);
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shortcuts]);
}
