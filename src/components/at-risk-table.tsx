"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { fmtCurrency, fmtDate, fmtNumber, fmtPct, daysAgo } from "./format";
import { OutreachModal } from "./outreach-modal";
import { CustomerDetailPanel } from "./customer-detail-panel";
import { useGmailLastContact } from "@/lib/hooks/use-gmail-last-contact";
import {
  useColumnVisibility,
  type ColumnDef,
} from "@/lib/hooks/use-column-visibility";
import { ColumnPicker } from "./column-picker";
import { lastContacted, subUtilFraction } from "@/lib/customer-helpers";
import { RowActions } from "./row-actions";
import { BulkEmailLauncher } from "./am/bulk-email-launcher";
import { RiskLevelChip } from "./risk-level-chip";
import { FlagResolutionCheckboxes } from "./flag-resolution-checkboxes";
import { JulietFlagControl } from "./juliet-flag-control";
import { ChipMultiSelect, FilterBar, FilterPanel, SearchInput, SegmentToggle } from "./filters";
import { CsmSelector } from "./csm-selector";
import { useUrlSearch } from "@/lib/hooks/use-url-search";
import { usePublicationsIndex } from "@/lib/hooks/use-publications-index";
import { composeUrlForTemplate } from "@/lib/links";
import { suggestTemplates } from "@/lib/templates/templates";
import { isVisibleToCsm, type StoredTemplate } from "@/lib/templates/types";
import { useViewerEmail } from "@/lib/auth-client";
import { getTierLadder } from "@/lib/tiers/client";
import type {
  AtRiskAccount,
  Customer,
  RiskFlag,
  RiskFlagCode,
} from "@/lib/types";
import type { TemplateScenario } from "@/lib/templates/templates";

// Short, human-readable label per flag code — drives the filter chips
// and the per-row flag chips. Labels are deliberately specific about
// the trigger ("No publishing 10d+") rather than vague ("Dormant") so
// you can tell at a glance which signal fired without hovering for
// the tooltip. Engine labels in lib/engines/at-risk.ts use the same
// strings (the row chip rendering reads `f.label` from the engine
// directly) so the two surfaces stay consistent.
//
// Order matters: the strip renders flags in this declared order so
// the most-common codes (A/B/C/G/H) come first.
const FLAG_META: Array<{ code: RiskFlagCode; label: string; description: string }> = [
  {
    code: "A",
    label: "No publishing (10d+)",
    description: "Hasn't sent a post in 10+ days, or never sent",
  },
  {
    code: "B",
    label: "No login (14d+)",
    description: "No admin login to beehiiv in the last 14 days",
  },
  {
    code: "C",
    label: "Under cap (<75%)",
    description: "Active subscribers below 75% of plan limit",
  },
  {
    code: "G",
    label: "CSM-flagged risk",
    description: "Yellow / Red risk level set on the HubSpot company record",
  },
  {
    code: "H",
    label: "Stale activity (45d+)",
    description:
      "No HubSpot OR Gmail-tracked activity across any contact at this company in 45+ days. Re-evaluated client-side against the Last contacted column, so a row whose HubSpot activity is old but whose Gmail thread is fresh isn't flagged.",
  },
  {
    code: "D",
    label: "Frustration signal",
    description: "Negative-sentiment Gmail signal detected in last 30 days",
  },
  {
    code: "E",
    label: "No outbound (90d+)",
    description: "No outbound email to this company in 90+ days (Gmail-detected)",
  },
  {
    code: "F",
    label: "News mention",
    description: "Notable news (acquisition, layoffs, etc.) on contact or company",
  },
];

interface RunResult {
  csm_name: string | null;
  total_in_book: number;
  excluded: number;
  accounts: AtRiskAccount[];
  generated_at: string;
  /** Threshold (days) for Flag H — passed from the server so the
   *  client can re-evaluate against the Gmail-merged Last contacted
   *  column. */
  threshold_days_no_contact: number;
}

const FLAG_COLORS: Record<string, string> = {
  A: "bg-blue-100 text-blue-800 dark:text-blue-300",
  B: "bg-indigo-100 text-indigo-800",
  C: "bg-amber-100 text-amber-800 dark:text-amber-300",
  D: "bg-red-100 text-red-800 dark:text-red-300",
  E: "bg-orange-100 text-orange-800",
  F: "bg-purple-100 text-purple-800",
  G: "bg-rose-100 text-rose-800",
  H: "bg-orange-100 text-orange-800",
};

function suggestedTemplate(flags: RiskFlag[]): TemplateScenario {
  const codes = new Set(flags.map((f) => f.code));
  if (codes.has("G")) return "escalation-yellow-red";
  if (codes.has("A")) return "dormant-no-send";
  if (codes.has("C")) return "growth-push-under-tier";
  return "general-checkin";
}

function pctVal(c: Customer): number | null {
  // Returns subscriber utilization as a *percentage* (75, 175, etc.)
  // for display. Routes through subUtilFraction so over-cap rows
  // render correctly (legacy `> 1` heuristic mis-handled 1.75
  // fractions as 175% percentages, dividing them to 0.0175 →
  // displaying "2%"). Multiply by 100 once here because the column
  // formatter expects an already-percentage value.
  const frac = subUtilFraction(c);
  return frac == null ? null : frac * 100;
}

/**
 * Toggleable column list for the at-risk table. Stable `key` strings
 * are persisted to localStorage by useColumnVisibility — don't rename
 * them (the picker will silently reset visibility for everyone).
 *
 * The four anchoring cells (selection checkbox, expand chevron,
 * Account name, Actions buttons) are NOT in this list — they're
 * always rendered. Everything below is opt-out-able via the
 * "Columns" dropdown above the table.
 */
const AT_RISK_COLUMNS: ColumnDef[] = [
  { key: "arr", label: "ARR" },
  { key: "last_send", label: "Last send" },
  { key: "flags", label: "Flags" },
  { key: "last_login", label: "Last login" },
  { key: "last_contacted", label: "Last contacted" },
  { key: "pct_subs", label: "% subs" },
  { key: "risk", label: "Risk" },
  { key: "recommended_action", label: "Recommended action" },
];

export function AtRiskTable({
  data,
  csms,
}: {
  data: RunResult;
  csms: string[];
}) {
  const viewerEmail = useViewerEmail();
  const router = useRouter();
  // Two-step inline confirmation for "Mark all flags resolved". The
  // previous implementation used window.confirm(), which some browser
  // setups (popup blockers, certain extensions, sandboxed iframes)
  // silently return `false` from — making the button appear broken
  // because the user never sees the dialog. Tracking confirm state in
  // React keeps the UI under our control.
  const [resolveConfirm, setResolveConfirm] = useState(false);
  const [outreachFor, setOutreachFor] = useState<{
    customer: Customer;
    scenario: TemplateScenario;
  } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  // Book-wide "Refresh from Gmail" — force-busts the 6h Gmail cache
  // for every customer in the active CSM scope. Lets a CSM start
  // their at-risk triage from the freshest possible "last contacted"
  // signal without waiting for the cache to age out. The sweep is
  // metered against the viewer's own Gmail quota (250 req/sec) and
  // typically finishes in ~15-30s for a 100-customer book.
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  // Client-side search across the already-flagged accounts. URL-synced
  // (`?q=…`) so navigating away and back restores the filter.
  const [search, setSearch] = useUrlSearch("q");
  // Publications index for the "paste a pub_… UUID" affordance.
  const { ws2pubs } = usePublicationsIndex();

  // Gmail-direct "Last contacted" overlay. Same hook as the customer
  // table — batches one POST on mount, results are merged into the
  // detail panel's "Last contacted" row when expanded. The at-risk
  // page benefits especially because Flag H ("Stale HubSpot
  // activity") often fires on accounts a CSM actually emailed last
  // week; the Gmail overlay surfaces the correction visually.
  const ownerEmailList = useMemo(
    () =>
      data.accounts
        .map((a) => a.customer.owner_email ?? "")
        .filter((e): e is string => Boolean(e)),
    [data.accounts]
  );
  const gmail = useGmailLastContact(ownerEmailList);
  // Per-table column visibility. Persists to
  // `csm:table-columns:at-risk` in localStorage so a CSM's
  // hide/show preferences survive reloads + nav.
  const columns = useColumnVisibility("at-risk", AT_RISK_COLUMNS);
  // colSpan for the expanded-details row: 4 always-on cells
  // (checkbox, expand, account, actions) + however many toggleable
  // columns are currently visible.
  const visibleToggleableCount = AT_RISK_COLUMNS.filter((c) =>
    columns.isVisible(c.key)
  ).length;
  const expandedColSpan = 4 + visibleToggleableCount;

  const gmailDateFor = useCallback(
    (c: Customer): string | undefined => {
      const email = (c.owner_email ?? "").trim().toLowerCase();
      if (!email) return undefined;
      return gmail.dateMap[email] ?? undefined;
    },
    [gmail.dateMap]
  );

  // Flag filter state. Empty pickedFlags = no filter (show all accounts).
  // combine = "any" matches accounts with at least one picked flag;
  // "all" requires every picked flag to be present.
  const [pickedFlags, setPickedFlags] = useState<Set<RiskFlagCode>>(new Set());
  const [combine, setCombine] = useState<"any" | "all">("any");

  function toggleFlag(code: RiskFlagCode) {
    setPickedFlags((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  // Re-evaluate Flag H (the "Stale activity" flag) against the
  // Gmail-merged Last contacted date the table actually displays.
  // The server computes H using HubSpot data only (no per-CSM
  // token available there); the client has the Gmail overlay
  // loaded by `useGmailLastContact`, so a row whose HubSpot
  // activity is stale but whose Gmail thread is fresh should NOT
  // be flagged — that's exactly the "filter on the Last contacted
  // column" semantics the panel needs.
  const thresholdDays = data.threshold_days_no_contact;
  const accountsWithGmailAwareH = useMemo(() => {
    return data.accounts.map((a) => {
      const gmailDate = gmailDateFor(a.customer);
      // If the Gmail hook hasn't returned for this row yet, leave
      // the server-side flags alone — the table will re-render once
      // the hook lands.
      if (gmailDate === undefined && !gmail.dateMap[a.customer.owner_email?.toLowerCase() ?? ""]) {
        return a;
      }
      const resolved = lastContacted(a.customer, { gmailDate });
      const lastMs = resolved.date ? new Date(resolved.date).getTime() : null;
      const nowMs = Date.now();
      const daysSince =
        lastMs !== null && Number.isFinite(lastMs)
          ? Math.floor((nowMs - lastMs) / (24 * 60 * 60 * 1000))
          : null;
      const shouldFlag =
        daysSince === null || daysSince >= thresholdDays;
      const hadH = a.flags.some((f) => f.code === "H");
      if (shouldFlag === hadH) return a; // no change
      if (shouldFlag) {
        // Server didn't flag (HubSpot fresh) but the merged-with-
        // Gmail view says stale → add H. (Rare — usually means
        // HubSpot's rollup overshot, e.g. a stale auto-import.)
        const newH: RiskFlag = {
          code: "H",
          label:
            daysSince === null
              ? "No recent activity"
              : `Stale activity (${daysSince}d)`,
          detail:
            daysSince === null
              ? "No HubSpot or Gmail-tracked activity recorded for this account."
              : `Last contacted ${daysSince} days ago across HubSpot + Gmail (threshold ${thresholdDays}d).`,
        };
        return { ...a, flags: [...a.flags, newH] };
      }
      // Server flagged H based on HubSpot, but the Gmail-merged
      // date is fresh enough — strip it.
      return { ...a, flags: a.flags.filter((f) => f.code !== "H") };
    });
    // gmail.dateMap is the load-bearing dep — gmailDateFor is a
    // stable callback bound to it. Including the callback would
    // recompute on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.accounts, gmail.dateMap, thresholdDays]);

  // Per-flag count across the whole result so the chip can show "(N)".
  // Independent of the active filter — always reflects the underlying data.
  const flagCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of accountsWithGmailAwareH) {
      for (const f of a.flags) {
        counts[f.code] = (counts[f.code] ?? 0) + 1;
      }
    }
    return counts;
  }, [accountsWithGmailAwareH]);

  const accounts = useMemo(() => {
    let list = accountsWithGmailAwareH;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(({ customer: c }) => {
        // CSMs are stored snake_cased — humanize so "olivia chen" and
        // "olivia_chen" both match. Same pattern used in customer-table.
        const csmRaw = c.customer_success_manager ?? null;
        const csmHuman = csmRaw?.replace(/_/g, " ") ?? null;
        // Pub IDs owned by this workspace so a pasted `pub_…` UUID
        // surfaces the parent account.
        const pubs = c.workspace_id ? ws2pubs[c.workspace_id] ?? [] : [];
        if (
          c.company_name?.toLowerCase().includes(q) ||
          c.workspace_name?.toLowerCase().includes(q) ||
          c.owner_email?.toLowerCase().includes(q) ||
          c.workspace_id?.toLowerCase().includes(q) ||
          c.stripe_customer_id?.toLowerCase().includes(q) ||
          csmRaw?.toLowerCase().includes(q) ||
          csmHuman?.toLowerCase().includes(q)
        ) {
          return true;
        }
        return pubs.some((p) => p.toLowerCase().includes(q));
      });
    }
    if (pickedFlags.size === 0) return list;
    return list.filter((a) => {
      const codes = new Set(a.flags.map((f) => f.code));
      if (combine === "any") {
        for (const code of pickedFlags) if (codes.has(code)) return true;
        return false;
      }
      for (const code of pickedFlags) if (!codes.has(code)) return false;
      return true;
    });
  }, [accountsWithGmailAwareH, pickedFlags, combine, search, ws2pubs]);

  const allKeys = useMemo(
    () =>
      accounts
        .map((a, i) => a.customer.workspace_id ?? `${i}`)
        .filter((k): k is string => Boolean(k)),
    [accounts]
  );

  // Reset selection + expansion when the underlying account set changes
  // (CSM filter, segment switch). Otherwise stale workspace IDs linger.
  const accountSignature = useMemo(
    () => allKeys.join("|"),
    [allKeys]
  );
  useEffect(() => {
    setSelected(new Set());
    setExpanded(new Set());
    setBulkMessage(null);
  }, [accountSignature]);

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleSelected(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAll() {
    if (selected.size === allKeys.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allKeys));
    }
  }

  /** POST /api/last-contact/gmail/refresh-book with the active CSM
   *  scope. Force-busts every cache entry; lastEmailWithBatch fans
   *  out at 8 concurrent. After success, calls router.refresh() so
   *  the at-risk RunResult re-computes against the freshly-warmed
   *  Gmail data on the next server-component pass. */
  async function refreshFromGmail() {
    setRefreshBusy(true);
    setRefreshMessage(null);
    try {
      // Mirror the at-risk page's CSM scope by reading the URL
      // param. Empty / missing → server defaults to ?csm=all per
      // the route's convention.
      const params = new URLSearchParams(window.location.search);
      const csm = params.get("csm") ?? "all";
      const url = new URL(
        "/api/last-contact/gmail/refresh-book",
        window.location.origin
      );
      url.searchParams.set("csm", csm);
      const r = await fetch(url.toString(), { method: "POST" });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        processed?: number;
        succeeded?: number;
        failed?: number;
        customers_in_scope?: number;
        unique_emails?: number;
        truncated?: boolean;
        needs_reconsent?: boolean;
        no_active_gmail?: boolean;
        error?: string;
      };
      if (!r.ok || j.ok === false) {
        if (j.needs_reconsent) {
          throw new Error(
            "Gmail scope missing — reconnect at /settings/gmail."
          );
        }
        if (j.no_active_gmail) {
          throw new Error(
            "No Gmail account connected for this browser. Visit /settings/gmail."
          );
        }
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      const parts: string[] = [];
      parts.push(
        `${j.succeeded ?? 0}/${j.processed ?? 0} customers refreshed`
      );
      if ((j.failed ?? 0) > 0) parts.push(`${j.failed} failed`);
      if (j.truncated) parts.push("hit 1000-email cap (refresh again)");
      setRefreshMessage(parts.join(" · "));
      // Re-run the page's server components so the at-risk engine
      // reads the freshly-cached Gmail data on its next pass.
      router.refresh();
    } catch (e) {
      setRefreshMessage(
        `Refresh failed: ${e instanceof Error ? e.message : "unknown"}`
      );
    } finally {
      setRefreshBusy(false);
    }
  }

  async function bulkResolve() {
    // Aggressive console + on-screen tracing because this button has
    // a history of feeling broken to users while silently failing.
    // Every branch logs so the next "doesn't work" report can be
    // diagnosed from browser DevTools without code changes.
    console.log("[at-risk] bulkResolve clicked", {
      selected_count: selected.size,
      accounts_in_view: accounts.length,
    });
    if (selected.size === 0) {
      console.warn("[at-risk] bulkResolve aborted — no rows selected");
      setBulkMessage(
        "Select at least one row before clicking Mark all flags resolved."
      );
      return;
    }
    // Inline confirmation: first click flips `resolveConfirm` so the
    // button morphs into "[ ✓ Confirm ] [ Cancel ]"; the second click
    // (on Confirm) re-enters this function with resolveConfirm=true
    // and skips the gate. Replaces the native window.confirm() that
    // some browsers silently rejected, leaving the button looking
    // broken with `confirm result { confirmed: false }` in logs.
    if (!resolveConfirm) {
      console.log("[at-risk] bulkResolve awaiting inline confirm");
      setResolveConfirm(true);
      setBulkMessage(null);
      return;
    }
    console.log("[at-risk] bulkResolve confirm result", { confirmed: true });
    setResolveConfirm(false);
    setBulkBusy(true);
    setBulkMessage("Working…");

    // Build the full list of (workspace_id, flag_code) pairs to mark
    // resolved upfront so we know the denominator + can fire writes
    // in parallel. Sequential POSTs took 10–30s on a multi-CSM batch
    // and the previous "silent catch" treated 5xx responses as
    // success, which is why this button looked broken: the toast
    // claimed N flags resolved while none of them actually got
    // written.
    const todo: Array<{ workspace_id: string; flag_code: string }> = [];
    const selectedMissingWs: string[] = [];
    for (const a of accounts) {
      const k = a.customer.workspace_id;
      if (!k) {
        // Selected key for this row was the array index (see allKeys
        // earlier in the file). The /api/flag-resolutions endpoint
        // requires workspace_id, so these rows can't be resolved
        // through the bulk path. Surface them so the user knows why.
        if (selected.has(String(accounts.indexOf(a)))) {
          selectedMissingWs.push(
            a.customer.workspace_name ?? a.customer.company_name ?? "(unknown)"
          );
        }
        continue;
      }
      if (!selected.has(k)) continue;
      for (const f of a.flags) {
        todo.push({ workspace_id: k, flag_code: f.code });
      }
    }
    console.log("[at-risk] bulkResolve plan", {
      todo_count: todo.length,
      selected_missing_workspace_id: selectedMissingWs.length,
    });
    if (todo.length === 0) {
      setBulkBusy(false);
      setBulkMessage(
        selectedMissingWs.length > 0
          ? `${selectedMissingWs.length} selected row(s) have no workspace_id and can't be resolved in bulk: ${selectedMissingWs.slice(0, 3).join(", ")}`
          : "Nothing to resolve — selected rows have no live flags."
      );
      return;
    }

    // Fire in parallel. The /api/flag-resolutions endpoint
    // read-modifies-writes the full KV row per POST, so we cap
    // concurrency to avoid last-write-wins overwriting each other.
    const CONCURRENCY = 4;
    const results: Array<{
      ok: boolean;
      error?: string;
      workspace_id: string;
      flag_code: string;
    }> = [];
    let cursor = 0;
    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= todo.length) return;
        const item = todo[i];
        try {
          const r = await fetch("/api/flag-resolutions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              workspace_id: item.workspace_id,
              flag_code: item.flag_code,
              resolved: true,
              resolved_by: viewerEmail ?? null,
            }),
          });
          if (!r.ok) {
            const body = (await r.json().catch(() => ({}))) as {
              error?: string;
            };
            results.push({
              ok: false,
              error: body.error ?? `HTTP ${r.status}`,
              workspace_id: item.workspace_id,
              flag_code: item.flag_code,
            });
          } else {
            results.push({ ok: true, ...item });
          }
        } catch (e) {
          results.push({
            ok: false,
            error: e instanceof Error ? e.message : "network error",
            workspace_id: item.workspace_id,
            flag_code: item.flag_code,
          });
        }
      }
    }
    console.log("[at-risk] firing parallel POSTs", {
      total: todo.length,
      concurrency: CONCURRENCY,
    });
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, todo.length) }, () =>
        worker()
      )
    );
    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;
    console.log("[at-risk] bulkResolve complete", {
      ok: okCount,
      fail: failCount,
      first_failures: results
        .filter((r) => !r.ok)
        .slice(0, 3)
        .map((r) => ({
          workspace_id: r.workspace_id,
          flag_code: r.flag_code,
          error: r.error,
        })),
    });
    if (failCount === 0) {
      setBulkMessage(
        `Marked ${okCount} flag${okCount === 1 ? "" : "s"} resolved across ${selected.size} account${selected.size === 1 ? "" : "s"}. Refreshing…`
      );
    } else {
      // Surface the first couple of failures inline so the user
      // can see WHY some didn't land — most common cause is a
      // workspace_id that the server rejected (404 / 400).
      const sample = results
        .filter((r) => !r.ok)
        .slice(0, 2)
        .map((r) => `${r.workspace_id}/${r.flag_code}: ${r.error}`)
        .join("; ");
      setBulkMessage(
        `Marked ${okCount} resolved, ${failCount} failed${sample ? ` (${sample})` : ""}. Refreshing…`
      );
    }
    // Trigger a server-component refresh so the at-risk engine
    // re-runs against the latest resolutions KV — without this the
    // user sees no change until they manually reload, which is why
    // the button felt broken even when the writes succeeded.
    router.refresh();
    setBulkBusy(false);
    setSelected(new Set());
  }

  async function bulkCompose() {
    if (selected.size === 0) return;
    setBulkBusy(true);
    setBulkMessage(null);
    try {
      const [templatesRes, ladder] = await Promise.all([
        fetch("/api/templates").then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return (await r.json()) as StoredTemplate[];
        }),
        getTierLadder().catch(() => []),
      ]);
      const templates = templatesRes.filter((t) =>
        isVisibleToCsm(t, viewerEmail)
      );
      let opened = 0;
      for (const a of accounts) {
        const k = a.customer.workspace_id;
        if (!k || !selected.has(k)) continue;
        const tplId = suggestedTemplate(a.flags);
        const tpl =
          templates.find((t) => t.id === tplId) ??
          templates.find((t) => t.id === "general-checkin") ??
          templates[0];
        if (!tpl) continue;
        const url = composeUrlForTemplate(tpl, a.customer, ladder);
        if (url) {
          window.open(url, "_blank", "noopener,noreferrer");
          opened++;
          // Stagger so popup blockers don't fire
          await new Promise((res) => setTimeout(res, 80));
        }
      }
      setBulkMessage(
        `Opened ${opened} Gmail compose tab${opened === 1 ? "" : "s"}.${
          opened !== selected.size
            ? " Some skipped (no email or template match)."
            : ""
        }`
      );
    } catch (e) {
      setBulkMessage(
        `Bulk compose failed: ${e instanceof Error ? e.message : "unknown"}`
      );
    } finally {
      setBulkBusy(false);
    }
  }

  const filterActive = pickedFlags.size > 0;
  const modeLabel = combine === "any" ? "any of" : "all of";

  return (
    <div className="space-y-4">
      <FilterBar>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search name, owner, CSM, workspace / publication ID…"
        />
        <CsmSelector csms={csms} />
        <button
          type="button"
          onClick={() => void refreshFromGmail()}
          disabled={refreshBusy}
          className="px-3 py-1.5 border border-border-strong rounded-md text-xs hover:bg-canvas disabled:opacity-50 ml-auto"
          title="Force a live Gmail lookup for every customer in the active CSM scope. Buster the 6h cache so the at-risk re-evaluation reads the freshest 'last contacted' signal. Takes ~15-30s for a 100-customer book."
        >
          {refreshBusy
            ? "Refreshing from Gmail… (~30s)"
            : "↻ Refresh from Gmail"}
        </button>
      </FilterBar>
      {refreshMessage ? (
        <div className="text-xs text-muted">{refreshMessage}</div>
      ) : null}
      <div className="text-xs text-muted">
        {filterActive || search ? (
          <>
            <strong className="text-fg">{accounts.length}</strong> of{" "}
            {data.accounts.length} flagged accounts match the filter
          </>
        ) : (
          <>{data.accounts.length} flagged</>
        )}
        {" · "}
        {data.total_in_book} in book · {data.excluded} excluded · generated{" "}
        {fmtDate(data.generated_at)}
      </div>

      {data.accounts.length > 0 ? (
        <FilterPanel
          title="Filter by flag"
          defaultOpen={filterActive}
          trailing={
            filterActive ? (
              <span>
                {pickedFlags.size} selected · {modeLabel}
              </span>
            ) : null
          }
        >
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted font-medium">Combine:</span>
              <SegmentToggle
                variant="compact"
                ariaLabel="Combine mode"
                options={[
                  { value: "any", label: "any" },
                  { value: "all", label: "all" },
                ]}
                value={combine}
                onChange={(v) => setCombine(v)}
              />
              {filterActive ? (
                <button
                  onClick={() => setPickedFlags(new Set())}
                  className="text-accent hover:underline ml-auto"
                >
                  Clear ({pickedFlags.size} selected · {modeLabel})
                </button>
              ) : (
                <span className="text-subtle ml-auto">
                  no flags selected — showing every flagged account
                </span>
              )}
            </div>
            <ChipMultiSelect
              options={FLAG_META.map(({ code, label, description }) => ({
                value: code,
                label,
                description: `${code} — ${description}`,
                badge: code,
                badgeClass: FLAG_COLORS[code] ?? "bg-surface-2",
              }))}
              selected={pickedFlags}
              onToggle={toggleFlag}
              countMap={flagCounts}
            />
          </div>
        </FilterPanel>
      ) : null}

      {data.accounts.length > 0 && accounts.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-canvas border border-border rounded-md">
          <span className="text-xs text-muted">
            <strong>{selected.size}</strong> selected of {allKeys.length}
          </span>
          <button
            onClick={selectAll}
            className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas"
          >
            {selected.size === allKeys.length ? "Deselect all" : "Select all"}
          </button>
          <div className="flex-1" />
          {/* Resolve the selected at-risk accounts to Customer[] for
           *  the BulkEmailLauncher. Same Customer object the table
           *  rows already hold — no extra fetch needed. Filter on
           *  workspace_id because that's the selection key. */}
          {(() => {
            const selectedCustomers = accounts
              .filter((a) =>
                a.customer.workspace_id
                  ? selected.has(a.customer.workspace_id)
                  : false
              )
              .map((a) => a.customer);
            return (
              <BulkEmailLauncher
                customers={selectedCustomers}
                defaultTemplateId="general-checkin"
                disabled={selected.size === 0}
                label={`📥 Draft for ${selected.size}`}
                trackingIdFor={(c) => c.workspace_id ?? null}
                auditLabel="At-risk email sent"
              />
            );
          })()}
          <button
            onClick={bulkCompose}
            disabled={bulkBusy || selected.size === 0}
            className="px-3 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas disabled:opacity-50"
            title="Open one Gmail compose tab per selected account using the per-flag suggested template. Faster than the modal when you just want to fan out browser tabs."
          >
            ✉️ Open Gmail for {selected.size}
          </button>
          {/* Inline two-step confirm — replaces window.confirm() so
           *  the action survives browsers / extensions that suppress
           *  native dialogs. First click flips to a Confirm/Cancel
           *  pair right inside the toolbar; second click on Confirm
           *  actually fires the writes. */}
          {resolveConfirm ? (
            <div className="inline-flex items-center gap-1.5 px-2 py-1 border border-amber-300 dark:border-amber-500/40 rounded-md bg-amber-50 dark:bg-amber-500/10">
              <span className="text-xs text-amber-900 dark:text-amber-200">
                Mark every flag on {selected.size}{" "}
                account{selected.size === 1 ? "" : "s"} resolved?
              </span>
              <button
                onClick={bulkResolve}
                disabled={bulkBusy}
                className="px-2 py-0.5 text-xs bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50"
              >
                ✓ Confirm
              </button>
              <button
                onClick={() => {
                  setResolveConfirm(false);
                  setBulkMessage(null);
                }}
                disabled={bulkBusy}
                className="px-2 py-0.5 text-xs border border-border-strong rounded hover:bg-canvas disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={bulkResolve}
              disabled={bulkBusy || selected.size === 0}
              className="px-3 py-1 text-xs border border-border-strong rounded-md bg-surface hover:bg-canvas disabled:opacity-50"
            >
              ✓ Mark all flags resolved for {selected.size}
            </button>
          )}
        </div>
      ) : null}

      {bulkMessage ? (
        <div className="text-xs text-muted bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-accent/30 rounded-md px-3 py-2">
          {bulkMessage}
        </div>
      ) : null}

      {data.accounts.length === 0 ? (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-800">
          No at-risk accounts in this view. Nicely done.
        </div>
      ) : accounts.length === 0 ? (
        <div className="bg-canvas border border-border rounded-lg p-4 text-sm text-muted">
          No flagged accounts match the current filter. Clear or loosen the
          filter to see results.
        </div>
      ) : (
        <>
          {/* Right-aligned "Columns ▾" picker above the table. Each
           *  CSM's hide-set persists in localStorage so the choice
           *  survives reloads. */}
          <div className="flex justify-end">
            <ColumnPicker state={columns} align="right" />
          </div>
        <div className="rounded-xl border border-border bg-surface shadow-card">
          {/* table-auto (no table-fixed) lets the browser size each
           *  column to its content. Combined with `whitespace-nowrap`
           *  on the date / numeric cells, this stops "May 12, 2026"
           *  wrapping across three lines like it did with the old
           *  hand-tuned table-fixed widths.
           *
           *  Hidden columns disappear entirely from the DOM (not just
           *  visually) so the remaining columns get the freed width.
           *  No horizontal-scroll fallback: when the column set is
           *  too wide to fit, the "Columns ▾" picker is the relief
           *  valve — hide a column to free real estate. This keeps
           *  every cell on one row at every visible-column subset. */}
          <table className="w-full text-sm">
            <thead className="bg-canvas">
              <tr className="text-left border-b border-border">
                <th className="px-2 py-2.5 w-8"></th>
                <th className="px-2 py-2.5 w-8"></th>
                <th className="px-2 py-2.5 font-medium text-muted">Account</th>
                {columns.isVisible("arr") ? (
                  <th className="px-2 py-2.5 font-medium text-muted text-right">
                    ARR
                  </th>
                ) : null}
                {columns.isVisible("last_send") ? (
                  <th className="px-2 py-2.5 font-medium text-muted">
                    Last send
                  </th>
                ) : null}
                {columns.isVisible("flags") ? (
                  <th className="px-2 py-2.5 font-medium text-muted">Flags</th>
                ) : null}
                {columns.isVisible("last_login") ? (
                  <th className="px-2 py-2.5 font-medium text-muted">
                    Last login
                  </th>
                ) : null}
                {columns.isVisible("last_contacted") ? (
                  <th className="px-2 py-2.5 font-medium text-muted">
                    Last contacted
                  </th>
                ) : null}
                {columns.isVisible("pct_subs") ? (
                  <th className="px-2 py-2.5 font-medium text-muted text-right">
                    % subs
                  </th>
                ) : null}
                {columns.isVisible("risk") ? (
                  <th className="px-2 py-2.5 font-medium text-muted">Risk</th>
                ) : null}
                {columns.isVisible("recommended_action") ? (
                  <th className="px-2 py-2.5 font-medium text-muted">
                    Recommended action
                  </th>
                ) : null}
                <th className="px-2 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a, i) => {
                const k = a.customer.workspace_id ?? `${i}`;
                const isOpen = expanded.has(k);
                const isChecked = selected.has(k);
                const c = a.customer;
                const flagCodes = new Set(a.flags.map((f) => f.code));

                const lastSendDays = daysAgo(c.last_send);
                const lastSendCls = flagCodes.has("A")
                  ? "text-red-600 font-semibold"
                  : "text-muted";

                const lastLoginDays = daysAgo(c.last_log_in);
                const lastLoginCls = flagCodes.has("B")
                  ? "text-red-600 font-semibold"
                  : "text-muted";

                const subs = pctVal(c);
                const subsCls = flagCodes.has("C")
                  ? "text-red-600 font-semibold"
                  : subs != null && subs > 90
                    ? "text-amber-600"
                    : "text-muted";

                return (
                  <Fragment key={k}>
                    <tr
                      onClick={() => toggleExpanded(k)}
                      className={`border-b border-border align-top cursor-pointer transition-colors ${
                        isOpen ? "bg-blue-50 dark:bg-blue-500/40" : "hover:bg-blue-50 dark:bg-blue-500/30"
                      }`}
                    >
                      <td
                        className="px-2 py-2.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleSelected(k)}
                          className="h-4 w-4 rounded border-border-strong cursor-pointer"
                          aria-label={`Select ${c.company_name ?? "row"}`}
                        />
                      </td>
                      <td className="px-2 py-2.5 text-subtle select-none">
                        <span
                          className={`inline-block transition-transform ${
                            isOpen ? "rotate-90" : ""
                          }`}
                        >
                          ▸
                        </span>
                      </td>
                      <td className="px-2 py-2.5 break-words">
                        <div className="font-medium text-fg">
                          {c.company_name ?? c.workspace_name}
                        </div>
                        <div className="text-xs text-muted break-words">
                          {c.customer_success_manager?.replace(/_/g, " ") ??
                            "unassigned"}
                        </div>
                      </td>
                      {columns.isVisible("arr") ? (
                        <td className="px-2 py-2.5 text-right font-medium">
                          {fmtCurrency(c.arr)}
                        </td>
                      ) : null}
                      {columns.isVisible("last_send") ? (
                        <td className={`px-2 py-2.5 ${lastSendCls}`}>
                          <div>{fmtDate(c.last_send)}</div>
                          {lastSendDays != null ? (
                            <div className="text-xs text-muted">
                              {lastSendDays}d ago
                            </div>
                          ) : (
                            <div className="text-xs text-muted">never</div>
                          )}
                        </td>
                      ) : null}
                      {columns.isVisible("flags") ? (
                      <td className="px-2 py-2.5">
                        {/* Compact badges per flag raised on this row. Sorted
                            by the canonical FLAG_META order (most-common
                            codes first) so the row reads consistently. Title
                            attribute carries the full per-flag description. */}
                        <div className="flex flex-wrap gap-1">
                          {FLAG_META.filter((m) => flagCodes.has(m.code)).map(
                            (m) => (
                              <span
                                key={m.code}
                                title={`${m.code} — ${m.label}: ${m.description}`}
                                className={`inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                  FLAG_COLORS[m.code] ?? "bg-surface-2 text-fg"
                                }`}
                              >
                                {m.code}
                              </span>
                            )
                          )}
                          {a.flags.length === 0 ? (
                            <span className="text-xs text-subtle italic">
                              —
                            </span>
                          ) : null}
                        </div>
                      </td>
                      ) : null}
                      {columns.isVisible("last_login") ? (
                        <td className={`px-2 py-2.5 ${lastLoginCls}`}>
                          {c.last_log_in ? (
                            <>
                              <div>{fmtDate(c.last_log_in)}</div>
                              {lastLoginDays != null ? (
                                <div className="text-xs text-muted">
                                  {lastLoginDays}d ago
                                </div>
                              ) : null}
                            </>
                          ) : (
                            <span className="italic text-muted">14d+</span>
                          )}
                        </td>
                      ) : null}
                      {/* Last contacted — merges HubSpot's activity rollup
                       *  with the active CSM's Gmail (pre-fetched once per
                       *  page load via useGmailLastContact). A green
                       *  "Gmail" pill flags rows where Gmail beat HubSpot
                       *  so a CSM eyeballing the at-risk list sees at a
                       *  glance which rows might be wrongly flagged. */}
                      {columns.isVisible("last_contacted") ? (
                      <td className="px-2 py-2.5">
                        {(() => {
                          const lc = lastContacted(c, {
                            gmailDate: gmailDateFor(c),
                          });
                          if (!lc.date) {
                            return (
                              <span className="italic text-muted text-xs">
                                —
                              </span>
                            );
                          }
                          const days = daysAgo(lc.date);
                          // When the source is Gmail, surface the matching
                          // message's Subject directly in the column so a
                          // CSM eyeballing the at-risk list can immediately
                          // tell whether a "today" date came from a real
                          // reply or a stray system message. Avoids forcing
                          // them to expand the row.
                          const match =
                            lc.source === "gmail" && c.owner_email
                              ? gmail.matchMap[
                                  c.owner_email.trim().toLowerCase()
                                ] ?? null
                              : null;
                          return (
                            <div>
                              <div className="flex items-center gap-1.5">
                                <span>{fmtDate(lc.date)}</span>
                                {lc.source === "gmail" ? (
                                  <span
                                    className="text-[9px] px-1 py-px rounded font-mono bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200"
                                    title="Resolved from your Gmail mailbox — fresher than the HubSpot rollup."
                                  >
                                    G
                                  </span>
                                ) : null}
                              </div>
                              {days != null ? (
                                <div className="text-xs text-muted">
                                  {days}d ago
                                </div>
                              ) : null}
                              {match && (match.subject || match.from) ? (
                                <div
                                  className="text-[10px] text-subtle break-words max-w-[200px] italic"
                                  title={[
                                    match.from ? `From: ${match.from}` : null,
                                    match.subject
                                      ? `Subject: ${match.subject}`
                                      : null,
                                  ]
                                    .filter(Boolean)
                                    .join("\n")}
                                >
                                  {match.subject ?? "(no subject)"}
                                </div>
                              ) : null}
                            </div>
                          );
                        })()}
                      </td>
                      ) : null}
                      {columns.isVisible("pct_subs") ? (
                        <td className={`px-2 py-2.5 text-right ${subsCls}`}>
                          <div>{fmtPct(subs)}</div>
                          {c.active_subs != null ? (
                            <div className="text-xs text-muted">
                              {fmtNumber(c.active_subs)}
                              {c.max_subscriptions != null
                                ? ` / ${fmtNumber(c.max_subscriptions)}`
                                : null}
                            </div>
                          ) : null}
                        </td>
                      ) : null}
                      {columns.isVisible("risk") ? (
                        <td className="px-2 py-2.5">
                          <RiskLevelChip
                            level={c.property_risk_level}
                            detail={c.property_risk_level_detail}
                          />
                        </td>
                      ) : null}
                      {columns.isVisible("recommended_action") ? (
                        <td className="px-2 py-2.5 text-fg text-xs break-words max-w-[220px]">
                          {a.recommended_action}
                        </td>
                      ) : null}
                      <td className="px-2 py-2.5">
                        <RowActions
                          customer={c}
                          onDraft={() =>
                            setOutreachFor({
                              customer: c,
                              scenario: suggestedTemplate(a.flags),
                            })
                          }
                        />
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-blue-50 dark:bg-blue-500/20 border-b border-border">
                        <td colSpan={expandedColSpan} className="px-6 py-4">
                          <CustomerDetailPanel
                            customer={c}
                            hideFeatureBreakdown
                            gmailDate={gmailDateFor(c)}
                            gmailMatch={
                              c.owner_email
                                ? gmail.matchMap[
                                    c.owner_email.trim().toLowerCase()
                                  ] ?? null
                                : null
                            }
                            onGmailRefresh={
                              c.owner_email
                                ? () =>
                                    gmail.refresh(c.owner_email as string)
                                : undefined
                            }
                            gmailScopeMissing={gmail.scopeMissing}
                            topSlot={
                              <div className="space-y-3">
                                <div className="rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-3">
                                  <h4 className="text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300 mb-2">
                                    Why this account is flagged
                                  </h4>
                                  <ul className="space-y-1">
                                    {a.flags.map((f) => (
                                      <li
                                        key={f.code}
                                        className="text-sm text-fg"
                                      >
                                        <span
                                          className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold mr-2 ${
                                            FLAG_COLORS[f.code] ?? "bg-surface-2"
                                          }`}
                                        >
                                          {f.code} · {f.label}
                                        </span>
                                        <span className="break-words">
                                          {f.detail}
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                  <p className="mt-2 text-xs text-amber-900">
                                    <strong>Recommended action:</strong>{" "}
                                    {a.recommended_action}
                                  </p>
                                </div>
                                <FlagResolutionCheckboxes
                                  workspaceId={c.workspace_id}
                                  flags={a.flags}
                                />
                                {c.workspace_id ? (
                                  <JulietFlagControl
                                    workspaceId={c.workspace_id}
                                  />
                                ) : null}
                              </div>
                            }
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}

      <p className="text-xs text-subtle">
        Click a row to expand details. Red values are the at-risk triggers.
      </p>

      {outreachFor && (
        <OutreachModal
          customer={outreachFor.customer}
          initialScenario={outreachFor.scenario}
          onClose={() => setOutreachFor(null)}
        />
      )}
    </div>
  );
}
