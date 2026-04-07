export type FindingSeverity = "error" | "warning" | "info";

export function normalizeFindingSeverity(value: unknown): FindingSeverity {
  if (typeof value !== "string") {
    return "info";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "error" || normalized === "critical" || normalized === "fatal" || normalized === "high" || normalized === "severe") {
    return "error";
  }
  if (
    normalized === "warning" ||
    normalized === "warn" ||
    normalized === "medium" ||
    normalized === "moderate" ||
    normalized === "caution"
  ) {
    return "warning";
  }
  return "info";
}
