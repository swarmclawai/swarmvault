import { useCallback, useEffect, useState } from "react";

export type HashRoute = {
  view: string;
  params: Record<string, string>;
};

function parseHash(hash: string): HashRoute {
  const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!trimmed) return { view: "", params: {} };
  const [view, query = ""] = trimmed.split("?");
  const params: Record<string, string> = {};
  if (query) {
    for (const part of query.split("&")) {
      const [rawKey, rawValue] = part.split("=");
      if (!rawKey) continue;
      params[decodeURIComponent(rawKey)] = rawValue ? decodeURIComponent(rawValue) : "";
    }
  }
  return { view: decodeURIComponent(view ?? ""), params };
}

function serializeHash(route: HashRoute): string {
  const view = route.view ? encodeURIComponent(route.view) : "";
  const entries = Object.entries(route.params).filter(([, value]) => value != null && value !== "");
  if (!entries.length) return view ? `#${view}` : "";
  const query = entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
  return `#${view}?${query}`;
}

export function useHashRoute() {
  const [route, setRoute] = useState<HashRoute>(() =>
    typeof window === "undefined" ? { view: "", params: {} } : parseHash(window.location.hash)
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const navigate = useCallback((next: HashRoute) => {
    if (typeof window === "undefined") return;
    const serialized = serializeHash(next);
    if (serialized !== window.location.hash) {
      window.location.hash = serialized;
    }
    setRoute(next);
  }, []);

  return { route, navigate };
}
