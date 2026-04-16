import { useEffect, useState } from "react";

export type StreamEvent = {
  id: string;
  type: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
  timestamp: string;
  meta?: Record<string, unknown>;
};

export type EventStreamState = {
  events: StreamEvent[];
  connected: boolean;
  error: string | null;
};

const MAX_EVENTS = 50;

export function useEventStream(url = "/api/events") {
  const [state, setState] = useState<EventStreamState>({ events: [], connected: false, error: null });

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    let cancelled = false;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = () => {
      try {
        source = new EventSource(url);
      } catch (error) {
        if (cancelled) return;
        setState((prev) => ({ ...prev, error: error instanceof Error ? error.message : String(error), connected: false }));
        return;
      }

      source.onopen = () => {
        if (cancelled) return;
        attempt = 0;
        setState((prev) => ({ ...prev, connected: true, error: null }));
      };

      source.onerror = () => {
        if (cancelled) return;
        setState((prev) => ({ ...prev, connected: false }));
        source?.close();
        // Exponential backoff for reconnect, capped.
        attempt += 1;
        const delay = Math.min(15_000, 500 * 2 ** Math.min(attempt, 5));
        reconnectTimer = setTimeout(connect, delay);
      };

      source.onmessage = (event) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(event.data) as StreamEvent;
          setState((prev) => ({
            ...prev,
            events: [parsed, ...prev.events].slice(0, MAX_EVENTS)
          }));
        } catch {
          /* ignore malformed events */
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [url]);

  return state;
}
