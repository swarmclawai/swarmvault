import type { StreamEvent } from "../hooks/useEventStream";

type ActivityFeedProps = {
  events: StreamEvent[];
  connected: boolean;
  error: string | null;
};

function formatTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleTimeString();
}

export function ActivityFeed({ events, connected, error }: ActivityFeedProps) {
  return (
    <section className="panel" aria-label="Activity feed">
      <h3 className="panel-heading">
        Activity
        <span className={`activity-status-pill ${connected ? "is-live" : "is-offline"}`}>{connected ? "live" : "offline"}</span>
      </h3>
      {error ? <p className="text-error">{error}</p> : null}
      {events.length === 0 ? (
        <p className="text-muted text-sm">
          {connected
            ? "Waiting for ingest, compile, lint, or watch events."
            : "No activity stream available. Run `swarmvault watch` to see live events."}
        </p>
      ) : (
        <div className="activity-feed" role="log" aria-live="polite">
          {events.map((event) => (
            <article key={event.id} className={`activity-item activity-${event.level}`}>
              <span className="activity-time">{formatTime(event.timestamp)}</span>
              <div>
                <p className="activity-message">{event.message}</p>
                <p className="activity-meta">
                  {event.type}
                  {event.meta?.duration_ms ? ` · ${event.meta.duration_ms}ms` : null}
                </p>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
