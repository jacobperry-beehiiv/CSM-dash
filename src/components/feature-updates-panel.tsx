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

  async function syncNow(opts: { backfill?: boolean } = {}) {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const qs = opts.backfill ? "?backfill=1" : "";
      const r = await fetch(`/api/feature-updates/sync${qs}`, {
        method: "POST",
      });
      const j = (await r.json()) as {
        added?: number;
        total?: number;
        error?: string;
      };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setSyncMessage(
        j.added === 0
          ? opts.backfill
            ? "Re-fetched recent history — nothing new added."
            : "No new updates."
          : `Pulled ${j.added} ${opts.backfill ? "back-filled" : "new"} update${
              j.added === 1 ? "" : "s"
            }.`
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

  // Only render posts that follow the team's "Feature name: X" Slack
  // convention. Threads, ad-hoc messages, channel chatter, etc. get
  // filtered out at the panel level — we keep them in the KV store in
  // case the convention evolves, but they don't pollute the home page.
  const allUpdates = store?.updates ?? [];
  const parsed = allUpdates
    .map((u) => ({ update: u, parsed: parseFeatureUpdate(u.text) }))
    .filter(
      (
        x
      ): x is {
        update: FeatureUpdate;
        parsed: { name: string; body: string };
      } => x.parsed !== null
    );
  const visible = expanded ? parsed : parsed.slice(0, PAGE_SIZE);

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
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => syncNow({ backfill: true })}
            disabled={syncing}
            className="px-3 py-1.5 border border-border-strong rounded-md text-xs hover:bg-canvas disabled:opacity-50"
            title="Re-fetch the most-recent 200 messages, ignoring the incremental cursor. Useful when a post fell into a sync gap."
          >
            Backfill
          </button>
          <button
            onClick={() => syncNow()}
            disabled={syncing}
            className="px-3 py-1.5 border border-border-strong rounded-md text-xs hover:bg-canvas disabled:opacity-50"
            title="Pull the latest messages from Slack now"
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        </div>
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
      ) : parsed.length === 0 ? (
        <div className="text-sm text-muted">
          {allUpdates.length === 0
            ? "No feature updates pulled yet. Click "
            : `${allUpdates.length} message${allUpdates.length === 1 ? "" : "s"} pulled from Slack, but none match the "Feature name:" format. Click `}
          <em>Sync now</em> to pull again from the configured channel.
        </div>
      ) : (
        <>
          <ul className="space-y-4">
            {visible.map(({ update, parsed: p }) => (
              <UpdateRow key={update.id} update={update} parsed={p} />
            ))}
          </ul>
          {parsed.length > PAGE_SIZE ? (
            <button
              onClick={() => setExpanded((e) => !e)}
              className="mt-3 text-xs text-accent hover:underline"
            >
              {expanded
                ? "Show fewer"
                : `Show ${parsed.length - PAGE_SIZE} more`}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

function UpdateRow({
  update,
  parsed,
}: {
  update: FeatureUpdate;
  parsed: { name: string; body: string };
}) {
  const [open, setOpen] = useState(false);
  const hasBody = parsed.body.trim().length > 0;
  return (
    <li className="border-l-2 border-border pl-3">
      <button
        type="button"
        onClick={() => hasBody && setOpen((o) => !o)}
        disabled={!hasBody}
        className={`w-full text-left flex items-baseline gap-2 ${
          hasBody ? "cursor-pointer" : "cursor-default"
        }`}
        aria-expanded={hasBody ? open : undefined}
      >
        {hasBody ? (
          <span
            aria-hidden
            className={`text-muted text-xs transition-transform inline-block ${
              open ? "rotate-90" : ""
            }`}
          >
            ▸
          </span>
        ) : null}
        <span
          className="text-sm font-semibold text-fg break-words"
          dangerouslySetInnerHTML={{ __html: renderSlackMrkdwn(parsed.name) }}
        />
      </button>
      {open ? (
        <>
          <div className="flex items-center gap-2 text-xs text-muted mt-1 ml-5">
            <span>{update.author_name}</span>
            <span>·</span>
            <span>
              {relativeTime(new Date(update.posted_at_ms).toISOString())}
            </span>
            {update.permalink ? (
              <>
                <span>·</span>
                <a
                  href={update.permalink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  Open in Slack
                </a>
              </>
            ) : null}
          </div>
          {hasBody ? (
            <div
              className="text-sm text-fg mt-2 ml-5 whitespace-pre-wrap break-words"
              // Slack mrkdwn → HTML is small enough to inline. The
              // renderer escapes everything first, then re-introduces
              // a fixed set of safe tags (b/i/code/anchor), so
              // untrusted Slack content can't smuggle markup through.
              dangerouslySetInnerHTML={{
                __html: renderSlackMrkdwn(parsed.body),
              }}
            />
          ) : null}
        </>
      ) : null}
    </li>
  );
}

/**
 * Parse a Slack feature-update post into a (name, body) pair.
 *
 * The team's convention is a leading line of the form
 *   `*Feature name:* <the name>`
 * (with or without the surrounding bold asterisks, and case-insensitive
 * on the label). We pull the name out, drop that line from the body,
 * and return the rest verbatim — every other labelled field stays in
 * place so readers see the full context underneath the title.
 *
 * Returns `null` when the post doesn't match the convention so the
 * panel can skip ad-hoc messages and thread replies that ended up in
 * the same channel.
 *
 * Also supports the variant where "Feature name" is on its own line
 * and the value is on the next non-blank line:
 *   `*Feature name*`
 *   `Bold Reports`
 */
function parseFeatureUpdate(
  text: string
): { name: string; body: string } | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // Strip Slack bold markers (asterisks) so the label is easy to
    // match regardless of formatting.
    const stripped = lines[i].replace(/\*/g, "").trim();
    const m = /^feature\s*name\s*:?\s*(.*)$/i.exec(stripped);
    if (!m) continue;

    // Case 1: value on the same line ("Feature name: Bold Reports").
    const inlineName = m[1].trim();
    if (inlineName) {
      const body = lines.filter((_, idx) => idx !== i).join("\n").trim();
      return { name: inlineName, body };
    }

    // Case 2: label-only line ("*Feature name*"), value on the next
    // non-blank line.
    for (let j = i + 1; j < lines.length; j++) {
      const value = lines[j].replace(/\*/g, "").trim();
      if (!value) continue;
      const drop = new Set<number>([i, j]);
      const body = lines
        .filter((_, idx) => !drop.has(idx))
        .join("\n")
        .trim();
      return { name: value, body };
    }
    // Label with no value following — not a valid feature post.
    return null;
  }
  return null;
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
