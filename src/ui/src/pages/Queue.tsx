/**
 * Queue page — pending tickets in pickup order, manual-mode invocation entry
 * point. Mirrors the wireframe at
 * `docs/design/sandcastle-ui-wireframes/queue.html`. Click "Run with
 * overrides…" or "▶ Run now" on any row to invoke a single-ticket scenario;
 * navigation jumps to the live session view as soon as the server allocates
 * a sessionId.
 */

import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";

import {
  fetchQueue,
  fetchScenarios,
  runScenarioRequest,
  type QueueTicket,
  type ScenarioOption,
} from "../api.js";
import { OverrideSheet } from "../queue/OverrideSheet.js";

const formatCreated = (iso: string | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  // Match the wireframe's "YYYY-MM-DD HH:mm" format.
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

interface PriorityChip {
  readonly className: string;
  readonly text: string;
}

const priorityChip = (priority: string | undefined): PriorityChip | null => {
  if (!priority) return null;
  const normalized = priority.toLowerCase();
  if (normalized === "high" || normalized === "highest") {
    return {
      className: "queue-row__priority queue-row__priority--high",
      text: `▲ ${priority}`,
    };
  }
  if (normalized === "low" || normalized === "lowest") {
    return { className: "queue-row__priority", text: `▽ ${priority}` };
  }
  return { className: "queue-row__priority", text: `◆ ${priority}` };
};

export const QueuePage = (): ReactElement => {
  const navigate = useNavigate();
  const [tickets, setTickets] = useState<QueueTicket[] | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [query, setQuery] = useState("");
  const [openTicket, setOpenTicket] = useState<QueueTicket | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchQueue(), fetchScenarios()])
      .then(([queue, scen]) => {
        if (cancelled) return;
        setTickets(queue);
        setScenarios(scen);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const visible = useMemo(() => {
    if (!tickets) return [];
    const q = query.trim().toLowerCase();
    if (q.length === 0) return tickets;
    return tickets.filter((t) =>
      `${t.id} ${t.title} ${t.labels.join(" ")}`.toLowerCase().includes(q),
    );
  }, [tickets, query]);

  const runNow = async (ticket: QueueTicket): Promise<void> => {
    if (runningId) return;
    if (scenarios.length === 0) {
      setError("No scenarios configured — manual runs are unavailable.");
      return;
    }
    setRunningId(ticket.id);
    setError(null);
    try {
      const { sessionId } = await runScenarioRequest({
        // v1: "Run now" picks the first configured scenario. Override sheet
        // lets the operator choose explicitly.
        scenario: scenarios[0]!.name,
        ticketId: ticket.id,
      });
      navigate(`/sessions/${encodeURIComponent(sessionId)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunningId(null);
    }
  };

  return (
    <main className="list-page">
      <header className="list-page__header">
        <div>
          <h1 className="list-page__title">Queue</h1>
          <p className="list-page__sub">
            Pending tickets from your backlog manager, in the order autopilot
            will pick them up. Tickets labelled <code>agent-error</code> are
            excluded.
          </p>
        </div>
        <div className="list-page__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setReloadTick((n) => n + 1)}
          >
            ↻ Refresh
          </button>
        </div>
      </header>

      <div className="filter-bar" role="search">
        <span aria-hidden="true">🔍</span>
        <input
          type="search"
          className="filter-bar__search"
          placeholder="Filter by ticket id, title, or label…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {error && (
        <div className="badge badge--error" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      {tickets === null && !error && <p className="list-page__sub">Loading…</p>}

      {tickets !== null && visible.length === 0 && (
        <p className="list-page__sub">
          {tickets.length === 0
            ? "Queue is empty — autopilot will idle until a new ticket lands."
            : "No tickets match the current filter."}
        </p>
      )}

      {visible.length > 0 && (
        <section className="session-list" aria-label="Queue">
          <header className="queue-list__head" role="row">
            <span>#</span>
            <span>Ticket</span>
            <span>Labels</span>
            <span>Priority</span>
            <span>Created</span>
            <span />
          </header>

          {visible.map((ticket, index) => {
            const chip = priorityChip(ticket.priority);
            const isFirst = index === 0;
            const isRunning = runningId === ticket.id;
            return (
              <div className="queue-row" role="row" key={ticket.id}>
                <span
                  className={
                    isFirst
                      ? "queue-row__order queue-row__order--next"
                      : "queue-row__order"
                  }
                >
                  {index + 1}
                </span>
                <span className="session-row__ticket-cell">
                  <span className="session-row__ticket">{ticket.id}</span>
                  <span className="session-row__title">{ticket.title}</span>
                </span>
                <span className="queue-row__labels">
                  {ticket.labels.map((label) => (
                    <span className="label-chip" key={label}>
                      {label}
                    </span>
                  ))}
                </span>
                <span className={chip?.className ?? "queue-row__priority"}>
                  {chip?.text ?? "—"}
                </span>
                <span className="queue-row__created">
                  {formatCreated(ticket.createdAt)}
                </span>
                <span className="queue-row__actions">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setOpenTicket(ticket)}
                    disabled={isRunning || scenarios.length === 0}
                  >
                    Run with overrides…
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => void runNow(ticket)}
                    disabled={isRunning || scenarios.length === 0}
                  >
                    {isRunning ? "Starting…" : "▶ Run now"}
                  </button>
                </span>
              </div>
            );
          })}
        </section>
      )}

      {openTicket && (
        <OverrideSheet
          ticket={openTicket}
          scenarios={scenarios}
          onClose={() => setOpenTicket(null)}
          onStarted={(sessionId) => {
            setOpenTicket(null);
            navigate(`/sessions/${encodeURIComponent(sessionId)}`);
          }}
        />
      )}
    </main>
  );
};
