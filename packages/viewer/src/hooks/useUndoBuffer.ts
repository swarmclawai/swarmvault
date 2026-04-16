import { useCallback, useEffect, useRef, useState } from "react";

export type UndoEntry = {
  id: string;
  label: string;
  expiresAt: number;
  undo: () => void | Promise<void>;
};

const DEFAULT_TTL_MS = 6_000;

export function useUndoBuffer(ttlMs: number = DEFAULT_TTL_MS) {
  const [entry, setEntry] = useState<UndoEntry | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setEntry(null);
  }, []);

  const push = useCallback(
    (label: string, undo: () => void | Promise<void>) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const expiresAt = Date.now() + ttlMs;
      setEntry({ id, label, expiresAt, undo });
      timerRef.current = setTimeout(() => {
        setEntry((current) => (current?.id === id ? null : current));
      }, ttlMs);
    },
    [ttlMs]
  );

  const performUndo = useCallback(async () => {
    if (!entry) return;
    await entry.undo();
    clear();
  }, [clear, entry]);

  useEffect(() => () => clear(), [clear]);

  return { entry, push, performUndo, dismiss: clear };
}
