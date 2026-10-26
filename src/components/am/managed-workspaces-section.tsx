"use client";

import { useCallback, useEffect, useState } from "react";
import { CollapsibleSection } from "../collapsible-section";
import { fmtCurrency, fmtDate, fmtNumber, fmtPct } from "../format";
import {
  masqueradeUrl,
  stripeCustomerUrl,
  systemAdminWorkspaceUrl,
} from "@/lib/links";

/**
 * Managed workspaces nested under a parent account.
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

interface ManagedMetrics {
  workspace_id: string;
  workspace_name: string | null;
  owner_email: string | null;
  plan_name: string | null;
  stripe_plan: string | null;
  stripe_customer_id: string | null;
  max_subscriptions: number | null;
  active_subs: number | null;
  mrr: number | null;
  arr: number | null;
  next_charge: string | null;
  last_send: string | null;
}

interface ManagedRow {
  workspace_id: string;
  workspace_name: string | null;
  note?: string | null;
  linked_by: string;
  linked_at: string;
  metrics: ManagedMetrics | null;
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

export function ManagedWorkspacesSection({ workspaceId }: Props) {
  const [rows, setRows] = useState<ManagedRow[] | null>(null);
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
      const r = await fetch(`/api/customers/${workspaceId}/managed-workspaces`, {
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
      const j = (await r.json()) as { managed?: ManagedRow[] };
      setRows(j.managed ?? []);
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
      const r = await fetch(`/api/customers/${workspaceId}/managed-workspaces`, {
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

  async function unlink(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const r = await fetch(
        `/api/customers/${workspaceId}/managed-workspaces?workspace=${encodeURIComponent(id)}`,
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

  // The empty state renders as a full section like its neighbours,
  // NOT as a bare text link. The first version did the latter on the
  // theory that an empty section shouldn't take up space — but the
  // detail panel is a stack of bordered section cards, so a lone
  // faint line between them reads as whitespace and the feature
  // became genuinely unfindable. Consistency with the surrounding
  // chrome beats saving a few pixels.

  return (
    <CollapsibleSection
      title="Managed workspaces"
      // Collapsed by default, like REQUESTS and NOTES either side of
      // it. An earlier version tried to auto-open when links existed,
      // which didn't work and shouldn't have: CollapsibleSection reads
      // defaultOpen once at mount, and `rows` is still null then
      // because the fetch hasn't landed. The trailing count is what
      // tells you there's something inside.
      defaultOpen={adding}
      trailing={
        <span className="text-[11px] text-muted">
          {rows === null
            ? "…"
            : rows.length > 0
              ? rows.length
              : "none linked"}
        </span>
      }
    >
      <p className="text-[11px] text-muted mb-2">
        Other workspaces this account runs. A non-enterprise workspace
        has no HubSpot company of its own, so it can never appear in
        the book — linking it here is the only way to see it.
        {rows && rows.length > 0 ? (
          <>
            {" "}
            Shown for context: these numbers are <strong>not</strong>{" "}
            included in the account&rsquo;s ARR, utilization or at-risk
            scoring.
          </>
        ) : null}
      </p>

      {error ? (
        <p className="text-[11px] text-red-600 dark:text-red-300 mb-2">
          {error}
        </p>
      ) : null}

      {rows === null ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted">
          Nothing linked yet.
        </p>
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
                    {m?.stripe_plan ?? m?.plan_name ? (
                      <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded-full border border-border-strong text-muted">
                        {m?.stripe_plan ?? m?.plan_name}
                      </span>
                    ) : null}
                  </div>
                  {m ? (
                    <>
                      {/* Same headline figures the book row shows, in
                          the same order, so a managed workspace reads
                          like the account above it rather than like a
                          different kind of object. */}
                      <div className="text-[11px] text-muted">
                        {/* fmtCurrency is the one helper in format.ts
                            that doesn't take null, unlike fmtNumber /
                            fmtDate / fmtPct — so guard here rather
                            than widen a shared signature mid-task. */}
                        {m.arr != null ? `${fmtCurrency(m.arr)} ARR` : "ARR —"}
                        {m.mrr != null ? ` · ${fmtCurrency(m.mrr)} MRR` : ""}
                        {" · "}
                        {fmtNumber(m.active_subs)} subs
                        {util != null ? ` · ${fmtPct(util)} of plan` : ""}
                      </div>
                      <div className="text-[11px] text-muted">
                        {m.last_send
                          ? `sent ${fmtDate(m.last_send)}`
                          : "never sent"}
                        {m.next_charge
                          ? ` · next charge ${fmtDate(m.next_charge)}`
                          : ""}
                      </div>
                    </>
                  ) : (
                    // Link exists but ClickHouse didn't answer. Say so
                    // rather than rendering zeros.
                    <div className="text-[11px] text-muted italic">
                      metrics unavailable right now
                    </div>
                  )}
                  {m?.owner_email ? (
                    <div className="text-[11px] text-subtle truncate">
                      {m.owner_email}
                    </div>
                  ) : null}
                  {/* The same quick-links a book row carries. HubSpot
                      is deliberately absent: a managed workspace has
                      no HubSpot company — that's the whole reason it
                      can't appear in the book. */}
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <QuickLink
                      href={masqueradeUrl(m?.owner_email)}
                      label="Masq"
                      title="Masquerade into this workspace"
                    />
                    <QuickLink
                      href={stripeCustomerUrl(m?.stripe_customer_id)}
                      label="Stripe"
                      title="Open this workspace's Stripe customer"
                    />
                    <QuickLink
                      href={systemAdminWorkspaceUrl(row.workspace_id)}
                      label="Sys admin"
                      title="Open this workspace in beehiiv system admin"
                    />
                  </div>
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
          + Link a managed workspace
        </button>
      )}
    </CollapsibleSection>
  );
}

/** One external link, rendered only when we can build a valid URL.
 *  Every links.ts helper returns null on missing input, so an absent
 *  Stripe id simply drops that pill rather than producing a dead
 *  link — the same posture the rest of the panel takes. */
function QuickLink({
  href,
  label,
  title,
}: {
  href: string | null;
  label: string;
  title: string;
}) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-full border border-border-strong text-fg hover:bg-canvas"
    >
      {label}
      <span aria-hidden>↗</span>
    </a>
  );
}
