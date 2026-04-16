import type { VaultConfig } from "./types.js";

/**
 * Effective tuning thresholds for graph output. These knobs keep report and
 * similarity surfaces readable on large repositories while preserving
 * friendly defaults on small ones. Every caller that picks a graph limit
 * should route through {@link resolveLargeRepoDefaults} so user-provided
 * overrides stay authoritative and defaults adjust automatically based on
 * node count.
 */
export interface ResolvedLargeRepoDefaults {
  /** Upper bound on god-node entries surfaced in the report/tooling. */
  godNodeLimit: number;
  /**
   * Community rollup threshold: any community with fewer than this many
   * members is folded into the rollup summary in the report. Defaults to
   * `max(3, ceil(totalCommunities / 50))` when `totalCommunities` is
   * provided, otherwise to 3.
   */
  foldCommunitiesBelow: number;
  /**
   * Hard cap on the number of inferred similarity edges emitted per graph.
   * Prevents degenerate O(n²) fan-out on very large repos.
   */
  similarityEdgeCap: number;
  /**
   * Minimum IDF weight a similarity feature must carry to contribute to an
   * edge score. Features below the floor are dropped entirely.
   */
  similarityIdfFloor: number;
}

/** Node count at which tighter defaults begin firing. */
export const LARGE_REPO_NODE_THRESHOLD = 1000;

const DEFAULT_SMALL_GOD_NODE_LIMIT = 20;
const DEFAULT_LARGE_GOD_NODE_LIMIT = 10;
const DEFAULT_SIMILARITY_IDF_FLOOR = 0.5;
const SIMILARITY_EDGE_CAP_MAX = 20_000;
const SIMILARITY_EDGE_CAP_PER_NODE = 5;
const MIN_FOLD_BELOW = 3;

function clampPositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function clampNonNegativeNumber(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

/**
 * Resolve effective numeric thresholds for a graph of `nodeCount` nodes.
 * User-configured values on `config.graph` always win — defaults only fire
 * when the caller has left the knob unset. Pass `totalCommunities` when the
 * community rollup threshold needs to scale with the community count.
 */
export function resolveLargeRepoDefaults(input: {
  nodeCount: number;
  totalCommunities?: number;
  config?: VaultConfig | null;
}): ResolvedLargeRepoDefaults {
  const nodeCount = Math.max(0, Math.floor(input.nodeCount));
  const totalCommunities = Math.max(0, Math.floor(input.totalCommunities ?? 0));
  const graphConfig = input.config?.graph;
  const isLargeRepo = nodeCount > LARGE_REPO_NODE_THRESHOLD;

  const defaultGodNodeLimit = isLargeRepo ? DEFAULT_LARGE_GOD_NODE_LIMIT : DEFAULT_SMALL_GOD_NODE_LIMIT;
  const godNodeLimit =
    graphConfig?.godNodeLimit !== undefined ? clampPositiveInteger(graphConfig.godNodeLimit, defaultGodNodeLimit) : defaultGodNodeLimit;

  const defaultSimilarityEdgeCap = Math.min(SIMILARITY_EDGE_CAP_MAX, Math.max(0, SIMILARITY_EDGE_CAP_PER_NODE * nodeCount));
  const similarityEdgeCap =
    graphConfig?.similarityEdgeCap !== undefined
      ? clampPositiveInteger(graphConfig.similarityEdgeCap, defaultSimilarityEdgeCap)
      : defaultSimilarityEdgeCap;

  const similarityIdfFloor =
    graphConfig?.similarityIdfFloor !== undefined
      ? clampNonNegativeNumber(graphConfig.similarityIdfFloor, DEFAULT_SIMILARITY_IDF_FLOOR)
      : DEFAULT_SIMILARITY_IDF_FLOOR;

  const defaultFoldBelow = Math.max(MIN_FOLD_BELOW, Math.ceil(totalCommunities / 50));
  const foldCommunitiesBelow =
    graphConfig?.foldCommunitiesBelow !== undefined
      ? clampPositiveInteger(graphConfig.foldCommunitiesBelow, defaultFoldBelow)
      : defaultFoldBelow;

  return {
    godNodeLimit,
    foldCommunitiesBelow,
    similarityEdgeCap,
    similarityIdfFloor
  };
}
