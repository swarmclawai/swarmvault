import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path/posix";
import { WORKSPACE_MARKER, WORKSPACE_WALKUP_LIMIT } from "../constants";

export interface ResolveRootOptions {
  override?: string;
  maxDepth?: number;
  exists?: (path: string) => boolean;
  isDirectory?: (path: string) => boolean;
}

export interface WorkspaceRootResolution {
  root: string | null;
  source: "override" | "marker" | "not-found";
}

export function resolveWorkspaceRoot(start: string | null | undefined, options: ResolveRootOptions = {}): WorkspaceRootResolution {
  const exists = options.exists ?? ((p) => existsSync(p));
  const isDirectory =
    options.isDirectory ??
    ((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });

  if (options.override && options.override.length > 0) {
    const abs = isAbsolute(options.override) ? options.override : resolve(options.override);
    if (exists(join(abs, WORKSPACE_MARKER))) {
      return { root: abs, source: "override" };
    }
    return { root: null, source: "not-found" };
  }

  if (!start) return { root: null, source: "not-found" };
  const startAbs = isAbsolute(start) ? start : resolve(start);
  const maxDepth = options.maxDepth ?? WORKSPACE_WALKUP_LIMIT;

  let current = isDirectory(startAbs) ? startAbs : dirname(startAbs);
  const rootOfDrive = parse(current).root;

  for (let depth = 0; depth <= maxDepth; depth++) {
    if (exists(join(current, WORKSPACE_MARKER))) {
      return { root: current, source: "marker" };
    }
    if (current === rootOfDrive) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return { root: null, source: "not-found" };
}
