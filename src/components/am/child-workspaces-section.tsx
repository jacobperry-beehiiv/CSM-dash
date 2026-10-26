"use client";

import { useCallback, useEffect, useState } from "react";
import { CollapsibleSection } from "../collapsible-section";
import { fmtDate, fmtNumber, fmtPct } from "../format";

/**
 * Child workspaces nested under a parent account.
 *
 * ─── Why this section exists ──────────────────────────────────────
 * The book is built from HubSpot companies that have a CSM. An
 * enterprise customer running a second, non-enterprise workspace has
 * no HubSpot company for it, so that workspace is invisible here
 * regardless of how much it matters to the relationship. Linking it
 * puts its real numbers on the parent's profile.
 *
 * Nested display only — these figures are deliberately NOT rolled into
 * the parent's ARR, utilization or at-risk scoring. Changing numbers
 * CSMs already work from is a separate decision, and doing it silently
 * would be the wrong way to make it.
 *
 * Client island, fetched on mount: the subscriber count is a live
 * ClickHouse aggregate that takes a few seconds for a handful of ids.
 * Same posture as the News and Requests sections — never on the
 * critical path of a profile render.
 */

interface ChildMetrics {
  workspace_id: string;
  workspace_name: string | null;
  owner_email: string | null;
  plan_name: string | null;
  max_subscriptions: number | null;
  active_subs: number | null;
  last_send: string | null;
}

interface ChildRow {
  workspace_id: string;
  workspace_name: string | null;
  note?: string | null;
  linked_by: string;
  linked_at: string;
  metrics: ChildMetrics | null;
}

interface SearchHit {
  workspace_id: string;
  workspace_name: string | null;
  owner_email: string | null;
  plan_name: string | null;
}

interface Props {
  workspaceId: string;
}

export function ChildWorkspacesSection({ workspaceId }: Props) {
  const [rows, setRows] = useState<ChildRow[] | null>(null);
  // Self-gating: the section mounts unconditionally and hides itself
  // when the API says the viewer doesn't have the flag. Saves
  // threading a third boolean down through CustomerTable for a
  // feature that already has to call the API anyway.
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/customers/${workspaceId}/children`, {
        cache: "no-store",
      });
      if (!r.ok) {
        // 403 = flag off for this viewer. Render nothing rather than
        // an error — they aren't meant to see the section at all.
        if (r.status === 403) {
          setForbidden(true);
          setRows([]);
          return;
        }
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      const j = (await r.json()) as { children?: ChildRow[] };
      setRows(j.children ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setRows([]);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Debounced typeahead. 300ms is enough to stop a per-keystroke scan
  // of ~667k organizations without feeling laggy.
  useEffect(() => {
    if (!adding || query.trim().length < 3) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(
          `/api/workspaces/search?q=${encodeURIComponent(query.trim())}`,
          { cache: "no-store" }
        );
        const j = (await r.json()) as { results?: SearchHit[] };
        if (!cancelled) setHits(j.results ?? []);
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, adding]);

  async function link(hit: SearchHit) {
    setBusyId(hit.workspace_id);
    setError(null);
    try {
      const r = await fetch(`/api/customers/${workspaceId}/children`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: hit.workspace_id,
          workspace_name: hit.workspace_name,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setQuery("");
      setHits([]);
      setAdding(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't link");
    } finally {
      setBusyId(null);
    }
  }

  async function unlink(childId: string) {
    setBusyId(childId);
    setError(null);
    try {
      const r = await fetch(
        `/api/customers/${workspaceId}/children?child=${encodeURIComponent(childId)}`,
        { method: "DELETE" }
      );
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't unlink");
    } finally {
      setBusyId(null);
    }
  }

  if (forbidden) return null;

  // Nothing linked and nothing loading — stay out of the way. The
  // section only earns its space once there's a relationship to show
  // or the CSM has gone looking for one.
  if (rows !== null && rows.length === 0 && !adding && !error) {
    return (
      <div className="pt-1">
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="text-[11px] text-muted hover:text-fg underline underline-offset-2"
        >
          + Link a child workspace
        </button>
      </div>
    );
  }

  return (
    <CollapsibleSection
      title="Child workspaces"
      defaultOpen
      trailing={
        rows && rows.length > 0 ? (
          <span className="text-[11px] text-muted">{rows.length}</span>
        ) : undefined
      }
    >
      <p className="text-[11px] text-muted mb-2">
        Workspaces this account runs that aren&rsquo;t their own
        enterprise record. Shown for context — these numbers are{" "}
        <strong>not</strong> included in the account&rsquo;s ARR,
        utilization or at-risk scoring.
      </p>

      {error ? (
        <p className="text-[11px] text-red-600 dark:text-red-300 mb-2">
          {error}
        </p>
      ) : null}

      {rows === null ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => {
            const m = row.metrics;
            const util =
              m?.active_subs != null && m?.max_subscriptions
                ? (m.active_subs / m.max_subscriptions) * 100
                : null;
            return (
              <li
                key={row.workspace_id}
                className="py-2 flex items-start justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="text-sm text-fg truncate">
                    {m?.workspace_name ??
                      row.workspace_name ??
                      row.workspace_id}
                    {m?.plan_name ? (
                      <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded-full border border-border-strong text-muted">
                        {m.plan_name}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-[11px] text-muted">
                    {m ? (
                      <>
                        {fmtNumber(m.active_subs)} subs
                        {util != null ? ` · ${fmtPct(util)} of plan` : ""}
                        {" · "}
                        {m.last_send
                          ? `sent ${fmtDate(m.last_send)}`
                          : "never sent"}
                      </>
                    ) : (
                      // Link exists but ClickHouse didn't answer.
                      // Say so rather than rendering zeros.
                      <span className="italic">
                        metrics unavailable right now
                      </span>
                    )}
                  </div>
                  {m?.owner_email ? (
                    <div className="text-[11px] text-subtle truncate">
                      {m.owner_email}
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => unlink(row.workspace_id)}
                  disabled={busyId === row.workspace_id}
                  className="shrink-0 text-[11px] text-muted hover:text-red-600 dark:hover:text-red-300 disabled:opacity-50"
                  title="Unlink this workspace from the account"
                >
                  {busyId === row.workspace_id ? "…" : "Unlink"}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {adding ? (
        <div className="mt-2 space-y-1.5">
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search workspaces by name, or paste a workspace ID…"
            className="w-full px-2.5 py-1.5 text-xs bg-surface border border-border-strong rounded-md text-fg focus:outline-none focus:ring-2 focus:ring-accent"
          />
          {query.trim().length > 0 && query.trim().length < 3 ? (
            <p className="text-[11px] text-subtle">
              Keep typing — at least 3 characters.
            </p>
          ) : null}
          {searching ? (
            <p className="text-[11px] text-subtle">Searching…</p>
          ) : null}
          {hits.length > 0 ? (
            <ul className="border border-border rounded-md divide-y divide-border max-h-56 overflow-y-auto">
              {hits.map((h) => (
                <li key={h.workspace_id}>
                  <button
                    type="button"
                    onClick={() => link(h)}
                    disabled={busyId === h.workspace_id}
                    className="w-full text-left px-2.5 py-1.5 hover:bg-canvas disabled:opacity-50"
                  >
                    <span className="block text-xs text-fg truncate">
                      {h.workspace_name ?? h.workspace_id}
                      {h.plan_name ? (
                        <span className="ml-2 text-[10px] text-muted">
                          {h.plan_name}
                        </span>
                      ) : null}
                    </span>
                    <span className="block text-[11px] text-subtle truncate">
                      {h.owner_email ?? h.workspace_id}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              setQuery("");
              setHits([]);
            }}
            className="text-[11px] text-muted hover:text-fg"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-2 text-[11px] text-muted hover:text-fg underline underline-offset-2"
        >
          + Link a child workspace
        </button>
      )}
    </CollapsibleSection>
  );
}
