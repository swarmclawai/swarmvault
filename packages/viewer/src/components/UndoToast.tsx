import type { UndoEntry } from "../hooks/useUndoBuffer";

type UndoToastProps = {
  entry: UndoEntry | null;
  onUndo: () => void | Promise<void>;
  onDismiss: () => void;
};

export function UndoToast({ entry, onUndo, onDismiss }: UndoToastProps) {
  if (!entry) return null;
  return (
    <div className="undo-toast" role="status" aria-live="polite">
      <span>{entry.label}</span>
      <button type="button" className="btn btn-primary" onClick={() => void onUndo()}>
        Undo
      </button>
      <button type="button" className="btn btn-ghost" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
