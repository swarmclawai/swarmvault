import { useEffect, useMemo, useRef, useState } from "react";

export type PaletteCommand = {
  id: string;
  label: string;
  section?: string;
  shortcut?: string;
  keywords?: string[];
  run: () => void | Promise<void>;
};

type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
};

function score(command: PaletteCommand, query: string): number {
  const haystack = `${command.label} ${command.section ?? ""} ${(command.keywords ?? []).join(" ")}`.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  if (command.label.toLowerCase().startsWith(q)) return 100;
  if (haystack.includes(q)) return 50;
  const tokens = q.split(/\s+/).filter(Boolean);
  return tokens.every((token) => haystack.includes(token)) ? 25 : 0;
}

export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(() => {
    return commands
      .map((command) => ({ command, weight: score(command, query) }))
      .filter((entry) => entry.weight > 0)
      .sort((left, right) => right.weight - left.weight || left.command.label.localeCompare(right.command.label))
      .map((entry) => entry.command);
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      const id = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, []);

  if (!open) return null;

  const handleKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => Math.min(prev + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) => Math.max(prev - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const command = filtered[activeIndex];
      if (command) {
        void command.run();
        onClose();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="palette-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="palette">
        <input
          ref={inputRef}
          type="search"
          className="palette-input"
          placeholder="Type a command…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKey}
          aria-label="Command palette search"
        />
        <div className="palette-list">
          {filtered.length === 0 ? (
            <div className="palette-empty">No matching commands.</div>
          ) : (
            filtered.map((command, index) => (
              <button
                key={command.id}
                type="button"
                className={`palette-item${index === activeIndex ? " is-active" : ""}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => {
                  void command.run();
                  onClose();
                }}
              >
                <span>
                  {command.section ? <span className="text-muted text-xs">{command.section} · </span> : null}
                  {command.label}
                </span>
                {command.shortcut ? <span className="palette-item-shortcut">{command.shortcut}</span> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
