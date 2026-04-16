import { useEffect, useRef, useState } from "react";
import type { ViewerApprovalFrontmatterChange, ViewerApprovalStructuredDiff } from "../lib";

function renderValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function FrontmatterTable({ changes }: { changes: ViewerApprovalFrontmatterChange[] }) {
  if (!changes.length) return null;
  return (
    <table className="diff-frontmatter">
      <thead>
        <tr>
          <th>Field</th>
          <th>Before</th>
          <th>After</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((change) => (
          <tr key={change.key} className={change.protected ? "is-protected" : undefined}>
            <td className="text-mono">
              {change.key}
              {change.protected ? <span className="label label-danger"> protected</span> : null}
            </td>
            <td className="text-mono text-sm">{renderValue(change.before)}</td>
            <td className="text-mono text-sm">{renderValue(change.after)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type DiffViewProps = {
  diff: ViewerApprovalStructuredDiff;
  warnings?: string[];
};

export function DiffView({ diff, warnings }: DiffViewProps) {
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const protectedChanges = diff.frontmatterChanges.filter((change) => change.protected);
  const beforeRef = useRef<HTMLPreElement | null>(null);
  const afterRef = useRef<HTMLPreElement | null>(null);

  // Split-view scroll sync — keep both columns aligned.
  useEffect(() => {
    if (mode !== "split") return;
    const before = beforeRef.current;
    const after = afterRef.current;
    if (!before || !after) return;

    let lock = false;
    const sync = (source: HTMLPreElement, target: HTMLPreElement) => {
      if (lock) return;
      lock = true;
      target.scrollTop = source.scrollTop;
      target.scrollLeft = source.scrollLeft;
      requestAnimationFrame(() => {
        lock = false;
      });
    };
    const onBefore = () => sync(before, after);
    const onAfter = () => sync(after, before);
    before.addEventListener("scroll", onBefore);
    after.addEventListener("scroll", onAfter);
    return () => {
      before.removeEventListener("scroll", onBefore);
      after.removeEventListener("scroll", onAfter);
    };
  }, [mode]);

  return (
    <div className="diff-view">
      {warnings?.length ? (
        <p className="text-error text-sm">
          {warnings.includes("protected_frontmatter_changed")
            ? "Warning: protected frontmatter fields changed. Verify before accepting."
            : warnings.join(", ")}
        </p>
      ) : null}
      <FrontmatterTable changes={diff.frontmatterChanges} />
      {protectedChanges.length === 0 && diff.frontmatterChanges.length === 0 ? null : null}
      <div className="diff-toolbar">
        <span className="text-muted text-sm">
          +{diff.addedLines} / -{diff.removedLines}
        </span>
        <div className="action-row">
          <button type="button" className={`btn btn-ghost${mode === "unified" ? " is-active" : ""}`} onClick={() => setMode("unified")}>
            Unified
          </button>
          <button type="button" className={`btn btn-ghost${mode === "split" ? " is-active" : ""}`} onClick={() => setMode("split")}>
            Split
          </button>
        </div>
      </div>
      {diff.hunks.map((hunk) => (
        <div key={`hunk-${hunk.oldStart}-${hunk.newStart}`} className="diff-hunk">
          <div className="diff-hunk-header text-mono text-sm">
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
          </div>
          {mode === "unified" ? (
            <pre className="diff-unified">
              {hunk.lines.map((line, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: diff lines render in fixed order per render
                <div key={`u-${index}`} className={`diff-line diff-${line.type}`}>
                  <span className="diff-marker">{line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}</span>
                  <span className="diff-text">{line.value}</span>
                </div>
              ))}
            </pre>
          ) : (
            <div className="diff-split">
              <pre ref={beforeRef} className="diff-column diff-column-before">
                {hunk.lines
                  .filter((line) => line.type !== "add")
                  .map((line, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: filtered diff lines render in fixed order per render
                    <div key={`b-${index}`} className={`diff-line diff-${line.type}`}>
                      <span className="diff-text">{line.value}</span>
                    </div>
                  ))}
              </pre>
              <pre ref={afterRef} className="diff-column diff-column-after">
                {hunk.lines
                  .filter((line) => line.type !== "remove")
                  .map((line, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: filtered diff lines render in fixed order per render
                    <div key={`a-${index}`} className={`diff-line diff-${line.type}`}>
                      <span className="diff-text">{line.value}</span>
                    </div>
                  ))}
              </pre>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
