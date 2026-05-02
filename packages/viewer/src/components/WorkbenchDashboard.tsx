import { useState } from "react";
import type { ViewerActionResult, ViewerDoctorReport } from "../lib";

type WorkbenchActionResult = ViewerActionResult | ViewerDoctorReport | null | undefined;
type CaptureMode = "ingest" | "add" | "inbox";

type WorkbenchDashboardProps = {
  doctorReport: ViewerDoctorReport | null;
  doctorError?: string;
  busyAction: string;
  actionError?: string | null;
  onRepair: () => Promise<WorkbenchActionResult>;
  onCapture: (payload: {
    url?: string;
    title?: string;
    markdown?: string;
    selectionText?: string;
    sourceMode?: CaptureMode;
  }) => Promise<WorkbenchActionResult>;
  onBuildContext: (payload: { goal: string; target?: string; budgetTokens?: number }) => Promise<WorkbenchActionResult>;
  onStartTask: (payload: { goal: string; target?: string; budgetTokens?: number }) => Promise<WorkbenchActionResult>;
};

function statusLabel(status: ViewerDoctorReport["status"] | undefined): string {
  if (!status) return "unknown";
  return status;
}

function statusRank(status: ViewerDoctorReport["status"]): number {
  if (status === "error") return 0;
  if (status === "warning") return 1;
  return 2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : null;
}

function nestedStringField(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

function repairedItems(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.repaired)) return [];
  return value.repaired.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function actionReceipt(kind: "repair" | "capture" | "context" | "task", result: unknown): string {
  if (kind === "repair") {
    const repaired = repairedItems(result);
    return repaired.length ? `Repaired ${repaired.join(", ")}` : "Repair completed";
  }
  if (kind === "capture") {
    const label = stringField(result, "title") ?? stringField(result, "sourceId") ?? stringField(result, "inboxPath");
    return label ? `Captured ${label}` : "Capture completed";
  }
  if (kind === "context") {
    const id = nestedStringField(result, ["pack", "id"]) ?? stringField(result, "id") ?? stringField(result, "artifactPath");
    return id ? `Built context pack ${id}` : "Context pack built";
  }
  const id = nestedStringField(result, ["task", "id"]) ?? stringField(result, "id") ?? stringField(result, "artifactPath");
  return id ? `Started task ${id}` : "Task started";
}

function parseBudget(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function WorkbenchDashboard({
  doctorReport,
  doctorError,
  busyAction,
  actionError,
  onRepair,
  onCapture,
  onBuildContext,
  onStartTask
}: WorkbenchDashboardProps) {
  const [captureUrl, setCaptureUrl] = useState("");
  const [captureText, setCaptureText] = useState("");
  const [captureMode, setCaptureMode] = useState<CaptureMode>("ingest");
  const [goal, setGoal] = useState("");
  const [target, setTarget] = useState("");
  const [budget, setBudget] = useState("8000");
  const [receipt, setReceipt] = useState<string | null>(null);

  const canCapture = captureUrl.trim().length > 0 || captureText.trim().length > 0;
  const canUseGoal = goal.trim().length > 0;
  const checks = [...(doctorReport?.checks ?? [])].sort((left, right) => statusRank(left.status) - statusRank(right.status));
  const budgetTokens = parseBudget(budget);

  return (
    <section className="workbench-dashboard" aria-label="Vault workbench">
      <div className="workbench-strip">
        <div className={`health-pill health-${doctorReport?.status ?? "warning"}`}>
          <span className="health-dot" aria-hidden="true" />
          <span>Health {statusLabel(doctorReport?.status)}</span>
        </div>
        <span className="workbench-metric">Sources {doctorReport?.counts.sources ?? 0}</span>
        <span className="workbench-metric">Managed {doctorReport?.counts.managedSources ?? 0}</span>
        <span className="workbench-metric">Pages {doctorReport?.counts.pages ?? 0}</span>
        <span className="workbench-metric">Review {doctorReport?.counts.approvalsPending ?? 0}</span>
        <span className="workbench-metric">Tasks {doctorReport?.counts.tasks ?? 0}</span>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() =>
            void onRepair().then((result) => {
              setReceipt(actionReceipt("repair", result));
            })
          }
          disabled={busyAction === "doctor:repair"}
        >
          {busyAction === "doctor:repair" ? "Repairing" : "Repair"}
        </button>
      </div>

      {doctorError ? <p className="workbench-error">{doctorError}</p> : null}
      {actionError ? <p className="workbench-error">{actionError}</p> : null}
      {receipt ? <p className="workbench-receipt">{receipt}</p> : null}

      <div className="workbench-grid">
        <div className="workbench-card">
          <h2 className="workbench-card-title">Capture</h2>
          <select
            className="input"
            aria-label="Capture mode"
            value={captureMode}
            onChange={(event) => setCaptureMode(event.target.value as CaptureMode)}
          >
            <option value="ingest">URL ingest</option>
            <option value="add">Normalized add</option>
            <option value="inbox">Inbox clip</option>
          </select>
          <input
            className="input"
            aria-label="Capture URL"
            placeholder="URL"
            value={captureUrl}
            onChange={(event) => setCaptureUrl(event.target.value)}
          />
          <textarea
            className="input workbench-textarea"
            aria-label="Capture text"
            placeholder="Selected text or notes"
            value={captureText}
            onChange={(event) => setCaptureText(event.target.value)}
          />
          <div className="action-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canCapture || busyAction === "capture"}
              onClick={() =>
                void onCapture({
                  url: captureUrl.trim() || undefined,
                  selectionText: captureText.trim() || undefined,
                  sourceMode: captureMode
                }).then((result) => {
                  setReceipt(actionReceipt("capture", result));
                  setCaptureUrl("");
                  setCaptureText("");
                })
              }
            >
              Capture
            </button>
          </div>
        </div>

        <div className="workbench-card">
          <h2 className="workbench-card-title">Agent Context</h2>
          <input
            className="input"
            aria-label="Agent goal"
            placeholder="Goal"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
          />
          <input
            className="input"
            aria-label="Agent target"
            placeholder="Target path, page, or node"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
          <input
            className="input"
            aria-label="Token budget"
            type="number"
            min="1"
            step="500"
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
          />
          <div className="action-row">
            <button
              type="button"
              className="btn"
              disabled={!canUseGoal || busyAction === "context"}
              onClick={() =>
                void onBuildContext({ goal: goal.trim(), target: target.trim() || undefined, budgetTokens }).then((result) => {
                  setReceipt(actionReceipt("context", result));
                })
              }
            >
              Build Pack
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canUseGoal || busyAction === "task:start"}
              onClick={() =>
                void onStartTask({ goal: goal.trim(), target: target.trim() || undefined, budgetTokens }).then((result) => {
                  setReceipt(actionReceipt("task", result));
                  setGoal("");
                  setTarget("");
                })
              }
            >
              Start Task
            </button>
          </div>
        </div>

        <div className="workbench-card workbench-checks">
          <h2 className="workbench-card-title">Checks</h2>
          {checks.map((check) => (
            <div key={check.id} className={`workbench-check check-${check.status}`}>
              <div className="workbench-check-main">
                <div className="workbench-check-header">
                  <span>{check.label}</span>
                  <span>{check.status}</span>
                </div>
                <p>{check.summary}</p>
                {check.detail ? <p className="workbench-check-detail">{check.detail}</p> : null}
                {check.actions?.length ? (
                  <div className="workbench-command-list">
                    {check.actions.map((action) => (
                      <div key={action.command} className="workbench-command">
                        <code>{action.command}</code>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => {
                            void navigator.clipboard?.writeText(action.command);
                            setReceipt(`Copied ${action.command}`);
                          }}
                        >
                          Copy
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
