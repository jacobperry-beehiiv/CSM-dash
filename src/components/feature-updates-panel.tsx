"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  FeatureUpdate,
  FeatureUpdatesStore,
} from "@/lib/feature-updates/types";

/**
 * Read-only panel on the home page that shows the most recent
 * feature-update messages pulled from a Slack channel. Mirrors the
 * TeamTasksPanel pattern — client component, fetches its own data
 * from /api/feature-updates on mount, autosyncs nothing (a cron
 * triggers /api/feature-updates/sync; this panel just renders what's
 * already in the KV).
 *
 * "Sync now" button is provided as an admin-friendly manual refresh —
 * useful when a feature update just went out and we don't want to
 * wait for the next cron tick.
 */

const PAGE_SIZE = 8;

export function FeatureUpdatesPanel() {
  const [store, setStore] = useState<FeatureUpdatesStore | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await fetch("/api/feature-updates", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as FeatureUpdatesStore;
      setStore(data);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function syncNow() {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const r = await fetch("/api/feature-updates/sync", { method: "POST" });
      const j = (await r.json()) as {
        added?: number;
        total?: number;
        error?: string;
      };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setSyncMessage(
        j.added === 0
          ? "No new updates."
          : `Pulled ${j.added} new update${j.added === 1 ? "" : "s"}.`
      );
      await reload();
    } catch (e) {
      setSyncMessage(
        `Sync failed: ${e instanceof Error ? e.message : "unknown error"}`
      );
    } finally {
      setSyncing(false);
      // Clear the toast after a few seconds.
      setTimeout(() => setSyncMessage(null), 4500);
    }
  }

  const updates = store?.updates ?? [];
  const visible = expanded ? updates : updates.slice(0, PAGE_SIZE);

  return (
    <section className="bg-surface rounded-xl border border-border shadow-card p-5 mt-6">
      <div className="flex items-start justify-between mb-3 gap-3">
        <div>
          <h2 className="text-lg font-semibold text-fg tracking-tight">
            Feature updates
          </h2>
          <p className="text-xs text-muted mt-0.5">
            Latest messages pulled from the product feature-updates Slack
            channel.{" "}
            {store?.last_synced_at ? (
              <>Synced {relativeTime(store.last_synced_at)}.</>
            ) : (
              <>Never synced yet.</>
            )}
          </p>
        </div>
        <button
          onClick={syncNow}
          disabled={syncing}
          className="px-3 py-1.5 border border-border-strong rounded-md text-xs hover:bg-canvas disabled:opacity-50"
          title="Pull the latest messages from Slack now"
        >
          {syncing ? "Syncing…" : "Sync now"}
        </button>
      </div>

      {syncMessage ? (
        <div className="mb-3 text-xs text-muted">{syncMessage}</div>
      ) : null}

      {loadError ? (
        <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-md p-3 text-sm text-red-800 dark:text-red-300">
          {loadError}
        </div>
      ) : !store ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : updates.length === 0 ? (
        <div className="text-sm text-muted">
          No feature updates pulled yet. Click <em>Sync now</em> to
          backfill from the configured Slack channel.
        </div>
      ) : (
        <>
          <ul className="space-y-3">
            {visible.map((u) => (
              <UpdateRow key={u.id} update={u} />
            ))}
          </ul>
          {updates.length > PAGE_SIZE ? (
            <button
              onClick={() => setExpanded((e) => !e)}
              className="mt-3 text-xs text-accent hover:underline"
            >
              {expanded
                ? "Show fewer"
                : `Show ${updates.length - PAGE_SIZE} more`}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

function UpdateRow({ update }: { update: FeatureUpdate }) {
  return (
    <li className="border-l-2 border-border pl-3">
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="font-medium text-fg">{update.author_name}</span>
        <span>·</span>
        <span>{relativeTime(new Date(update.posted_at_ms).toISOString())}</span>
        {update.permalink ? (
          <>
            <span>·</span>
            <a
              href={update.permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              Open in Slack
            </a>
          </>
        ) : null}
      </div>
      <div
        className="text-sm text-fg mt-1 whitespace-pre-wrap break-words"
        // Slack mrkdwn → HTML is small enough to inline. The renderer
        // escapes everything first, then re-introduces a fixed set of
        // safe tags (b/i/code/anchor), so untrusted Slack content can't
        // smuggle markup through.
        dangerouslySetInnerHTML={{ __html: renderSlackMrkdwn(update.text) }}
      />
    </li>
  );
}

/**
 * Slack mrkdwn → sanitized HTML. Supports the small subset we actually
 * see in feature-update messages:
 *   *bold*  → <b>
 *   _italic_ → <i>
 *   `inline code` → <code>
 *   ```block``` → <pre>
 *   <https://url|label> → <a>
 *   <https://url> → <a>
 *   <@U01ABC> → @user (label only — we don't have the name handy at
 *               render time, so we just dim the placeholder)
 *
 * Everything else passes through as escaped text. We deliberately do
 * NOT support raw HTML or arbitrary attributes — the input is
 * untrusted Slack content.
 */
function renderSlackMrkdwn(input: string): string {
  // 1. Escape any literal HTML chars first.
  let s = input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // 2. Code blocks (```...```) — handled first so inline rules don't
  //    eat backticks inside them.
  s = s.replace(/```([\s\S]+?)```/g, (_m, body: string) => {
    return `<pre class="bg-surface-2 rounded p-2 text-xs overflow-x-auto">${body}</pre>`;
  });
  // 3. Inline code.
  s = s.replace(/`([^`\n]+)`/g, (_m, body: string) => {
    return `<code class="bg-surface-2 px-1 rounded text-[0.9em]">${body}</code>`;
  });
  // 4. Slack links: &lt;url|label&gt; or &lt;url&gt;. Note: HTML was
  //    already escaped, so the literal `<` is `&lt;` now.
  s = s.replace(
    /&lt;(https?:\/\/[^|&\s]+)\|([^&]+)&gt;/g,
    (_m, url: string, label: string) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">${label}</a>`
  );
  s = s.replace(
    /&lt;(https?:\/\/[^|&\s]+)&gt;/g,
    (_m, url: string) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">${url}</a>`
  );
  // 5. User mentions: <@U01ABCDEF> — render as a dim placeholder. We
  //    don't have name data at render time for arbitrary user ids; if
  //    a future iteration wants names, the sync route can pre-resolve
  //    and store them alongside the text.
  s = s.replace(/&lt;@([A-Z0-9]+)&gt;/g, (_m, id: string) => {
    return `<span class="text-muted">@${id}</span>`;
  });
  // 6. Channel mentions: <#C01ABCDEF|name>.
  s = s.replace(
    /&lt;#([A-Z0-9]+)\|([^&]+)&gt;/g,
    (_m, _id: string, name: string) =>
      `<span class="text-muted">#${name}</span>`
  );
  // 7. *bold* — Slack uses single * not **. Greedy but newline-bounded
  //    so a stray * doesn't swallow the rest of the message.
  s = s.replace(/\*([^*\n]+)\*/g, "<b>$1</b>");
  // 8. _italic_.
  s = s.replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, "$1<i>$2</i>");
  return s;
}

/** "12 minutes ago" / "3 days ago" style. Falls back to ISO date for
 *  anything older than 30 days. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  return new Date(then).toLocaleDateString();
}
