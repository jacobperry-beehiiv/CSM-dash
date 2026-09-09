"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Manual resync buttons for the Enterprise Request Loop. Each button
 * fires the same endpoint the nightly cron uses:
 *
 *   1. Linear sync                 — pulls every issue w/ customer_needs
 *   2. Shipped-detection sweep      — reads #devs-shipped + changelog
 *   3. #enterprise-bugs-and-fr sweep — links Slack posts to Linear tix
 *   4. Weekly per-CSM digest (dryRun toggle) — DMs shipped-this-week
 *
 * Ordering matters: sync writes the row set the sweeps annotate, so
 * the UI arranges the buttons in run-order and includes a "Run full
 * chain" convenience button that fires all three read sweeps in
 * sequence. Digest is intentionally kept separate — it POSTs to
 * Slack and shouldn't run silently as part of a "resync everything"
 * click.
 *
 * Every run posts to a `force-dynamic` endpoint with `maxDuration`
 * set high (up to 240s for the Linear sync). This component blocks
 * the button during the request and shows the response payload in a
 * status card so an admin can eyeball counts.
 */

interface RunState {
  running: boolean;
  ok: boolean | null;
  message: string | null;
  payload: unknown;
}

type Endpoint =
  | "sync"
  | "shipped-sweep"
  | "slack-intake-sweep"
  | "digest"
  | "digest-dry-run";

const ENDPOINTS: Record<Endpoint, { path: string; label: string; help: string }> = {
  sync: {
    path: "/api/enterprise-requests/sync",
    label: "1. Refresh from Linear",
    help: "Pulls every Linear issue that has ≥1 attached customer_need and rebuilds the snapshot. ~1–3 min.",
  },
  "shipped-sweep": {
    path: "/api/enterprise-requests/shipped-sweep",
    label: "2. Sweep #devs-shipped + #topic-product-changelog",
    help: "Reads new messages in the two release channels and promotes matched rows to Live / Live-possibly-in-beta.",
  },
  "slack-intake-sweep": {
    path: "/api/enterprise-requests/slack-intake-sweep",
    label: "3. Sweep #enterprise-bugs-and-feature-requests",
    help: "Links Slack posts to snapshot rows via Publication ID / User Email. Injects any Linear ticket that was posted but not yet attached as a customer_need.",
  },
  "digest-dry-run": {
    path: "/api/enterprise-requests/digest?dryRun=1",
    label: "Preview weekly digest (no Slack post)",
    help: "Renders the DM each CSM WOULD receive without sending. Safe to click anytime.",
  },
  digest: {
    path: "/api/enterprise-requests/digest",
    label: "Send weekly digest now",
    help: "Sends the shipped-this-week DM to every CSM. Deduped via the dm-sent blob — re-sends the same row never happen.",
  },
};

function StatusCard({ state }: { state: RunState }) {
  if (state.running) {
    return (
      <div className="text-xs rounded-md p-2 border bg-canvas border-border text-muted">
        Running…
      </div>
    );
  }
  if (state.ok == null) return null;
  const cls = state.ok
    ? "bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/30 text-emerald-900 dark:text-emerald-200"
    : "bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-900 dark:text-red-200";
  return (
    <div className={`text-xs rounded-md p-2 border ${cls} space-y-1`}>
      <div>
        <strong>{state.ok ? "OK" : "Failed"}</strong>
        {state.message ? ` — ${state.message}` : ""}
      </div>
      {state.payload != null ? (
        <pre className="text-[10px] whitespace-pre-wrap font-mono opacity-80">
          {JSON.stringify(state.payload, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

export function ResyncControls() {
  const router = useRouter();
  const [states, setStates] = useState<Record<Endpoint, RunState>>(() => {
    const initial = {} as Record<Endpoint, RunState>;
    for (const k of Object.keys(ENDPOINTS) as Endpoint[]) {
      initial[k] = { running: false, ok: null, message: null, payload: null };
    }
    return initial;
  });
  const [chainRunning, setChainRunning] = useState(false);

  async function run(endpoint: Endpoint) {
    setStates((prev) => ({
      ...prev,
      [endpoint]: { running: true, ok: null, message: null, payload: null },
    }));
    let ok = false;
    let message: string | null = null;
    let payload: unknown = null;
    try {
      const r = await fetch(ENDPOINTS[endpoint].path, {
        method: "POST",
        cache: "no-store",
      });
      const body = await r.json().catch(() => ({}));
      payload = body;
      if (!r.ok) {
        message =
          (body && typeof body === "object" && "error" in body
            ? String((body as { error: unknown }).error)
            : `HTTP ${r.status}`) ?? "Failed";
      } else {
        ok = true;
      }
    } catch (e) {
      message = e instanceof Error ? e.message : "Request failed";
    }
    setStates((prev) => ({
      ...prev,
      [endpoint]: { running: false, ok, message, payload },
    }));
    // Bust server caches so any surface reading the snapshot on the
    // next navigation sees the fresh data.
    router.refresh();
    return ok;
  }

  async function runChain() {
    setChainRunning(true);
    try {
      const okSync = await run("sync");
      if (!okSync) return;
      const okShipped = await run("shipped-sweep");
      if (!okShipped) return;
      await run("slack-intake-sweep");
    } finally {
      setChainRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-surface shadow-card p-4 space-y-2">
        <h2 className="text-sm font-semibold text-fg">Run everything</h2>
        <p className="text-xs text-muted">
          Fires the three read sweeps in sequence. Each waits for the prior
          one to finish so the counts on the shipped and Slack-intake sweeps
          reflect the freshly-synced snapshot.
        </p>
        <button
          type="button"
          onClick={() => void runChain()}
          disabled={chainRunning || Object.values(states).some((s) => s.running)}
          className="px-4 py-2 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
        >
          {chainRunning ? "Running full chain…" : "↻ Run full chain"}
        </button>
      </div>

      {(["sync", "shipped-sweep", "slack-intake-sweep"] as const).map((k) => (
        <div
          key={k}
          className="rounded-xl border border-border bg-surface shadow-card p-4 space-y-2"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-fg">
                {ENDPOINTS[k].label}
              </h3>
              <p className="text-xs text-muted">{ENDPOINTS[k].help}</p>
            </div>
            <button
              type="button"
              onClick={() => void run(k)}
              disabled={states[k].running || chainRunning}
              className="shrink-0 px-3 py-1.5 text-xs rounded border border-border-strong hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {states[k].running ? "Running…" : "Run now"}
            </button>
          </div>
          <StatusCard state={states[k]} />
        </div>
      ))}

      <div className="rounded-xl border border-border bg-surface shadow-card p-4 space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-fg">Weekly digest</h2>
          <p className="text-xs text-muted">
            The Monday cron fires this automatically. Preview it any day
            (dry-run) or send it now.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void run("digest-dry-run")}
            disabled={states["digest-dry-run"].running || states.digest.running}
            className="px-3 py-1.5 text-xs rounded border border-border-strong hover:bg-canvas disabled:opacity-50"
          >
            {states["digest-dry-run"].running ? "Rendering…" : "Preview (dry-run)"}
          </button>
          <button
            type="button"
            onClick={() => {
              if (
                confirm(
                  "Send the weekly Enterprise Request Loop digest to every CSM in the settings.slack.csm_user_ids map right now?"
                )
              ) {
                void run("digest");
              }
            }}
            disabled={states.digest.running || states["digest-dry-run"].running}
            className="px-3 py-1.5 text-xs rounded bg-accent text-accent-fg font-medium hover:bg-accent-hover disabled:opacity-50"
          >
            {states.digest.running ? "Sending…" : "Send digest now"}
          </button>
        </div>
        <StatusCard state={states["digest-dry-run"]} />
        <StatusCard state={states.digest} />
      </div>
    </div>
  );
}
