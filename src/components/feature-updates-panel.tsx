"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  FeatureUpdate,
  FeatureUpdatesStore,
} from "@/lib/feature-updates/types";
import { slackChannelUrl } from "@/lib/links";

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
  // Field extraction is cheap and runs only when the row is rendered,
  // so we recompute on each render rather than caching — keeps the
  // type-flow simple. If profiles ever show this as a hot path we can
  // memoize on parsed.body.
  const fields = parseFields(parsed.body);
  const postedIso = new Date(update.posted_at_ms).toISOString();
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
          className="text-sm font-semibold text-fg break-words flex-1"
          dangerouslySetInnerHTML={{ __html: renderSlackMrkdwn(parsed.name) }}
        />
        {/* Surface the posted date in the collapsed view so stale rows
         *  are obvious without expanding. Title attribute carries the
         *  exact ISO timestamp for inspection. */}
        <span
          className="text-[11px] text-subtle ml-2 flex-shrink-0"
          title={postedIso}
        >
          {relativeTime(postedIso)}
        </span>
      </button>
      {open ? (
        <ExpandedCard update={update} parsed={parsed} fields={fields} />
      ) : null}
    </li>
  );
}

/** The structured card layout shown when a row is expanded. Renders
 *  parsed fields as chips / inline labels / link buttons rather than
 *  the raw body text. Sections render only when their field is
 *  populated, so a sparse post collapses to whatever it actually has. */
function ExpandedCard({
  update,
  parsed,
  fields,
}: {
  update: FeatureUpdate;
  parsed: { name: string; body: string };
  fields: ParsedFields;
}) {
  const postedIso = new Date(update.posted_at_ms).toISOString();
  // PM gets surfaced in the header only when it's distinct from the
  // Slack author — otherwise it'd just say "Brett · Brett".
  const showPm =
    fields.product_manager &&
    fields.product_manager.toLowerCase() !==
      update.author_name.toLowerCase();

  // If somehow parseFields found nothing structured, fall back to
  // rendering the raw body so we never silently drop a post's content.
  const hasAnyField =
    fields.description ||
    fields.location ||
    fields.channel ||
    fields.notes ||
    (fields.plan && fields.plan.length > 0) ||
    (fields.roles && fields.roles.length > 0) ||
    fields.resources.length > 0 ||
    fields.other.length > 0;

  return (
    <div className="mt-3 ml-5 rounded-lg border border-border bg-canvas/40 p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span className="font-medium text-fg">{update.author_name}</span>
        {showPm ? (
          <>
            <span>·</span>
            <span>
              PM:{" "}
              <span className="text-fg font-medium">
                {fields.product_manager}
              </span>
            </span>
          </>
        ) : null}
        <span>·</span>
        <span>{relativeTime(postedIso)}</span>
        {update.permalink ? (
          <a
            href={update.permalink}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-accent hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            Open in Slack →
          </a>
        ) : null}
      </div>

      {fields.description ? (
        <div
          className="text-sm text-fg whitespace-pre-wrap break-words leading-relaxed"
          dangerouslySetInnerHTML={{
            __html: renderSlackMrkdwn(fields.description),
          }}
        />
      ) : null}

      {(fields.plan && fields.plan.length > 0) ||
      (fields.roles && fields.roles.length > 0) ||
      fields.location ||
      fields.channel ||
      fields.other.length > 0 ? (
        <div className="space-y-1.5">
          {fields.plan && fields.plan.length > 0 ? (
            <FieldRow label="Plan">
              {fields.plan.map((p) => (
                <Chip key={p}>{p}</Chip>
              ))}
            </FieldRow>
          ) : null}
          {fields.roles && fields.roles.length > 0 ? (
            <FieldRow label="Roles">
              {fields.roles.map((r) => (
                <Chip key={r}>{r}</Chip>
              ))}
            </FieldRow>
          ) : null}
          {fields.location ? (
            <FieldRow label="Location">
              <span className="text-sm text-fg">{fields.location}</span>
            </FieldRow>
          ) : null}
          {fields.channel ? (
            <FieldRow label="Channel">
              <ChannelValue raw={fields.channel} />
            </FieldRow>
          ) : null}
          {fields.other.map(({ label, value }) => (
            <FieldRow key={label} label={label}>
              <span className="text-sm text-fg break-words">{value}</span>
            </FieldRow>
          ))}
        </div>
      ) : null}

      {fields.resources.length > 0 ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {fields.resources.map((url) => {
            const { icon, label } = urlIcon(url);
            return (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-surface border border-border rounded-md text-xs text-fg hover:bg-canvas"
                title={url}
              >
                <span aria-hidden>{icon}</span>
                <span>{label}</span>
              </a>
            );
          })}
        </div>
      ) : null}

      {fields.notes ? (
        <div
          className="text-xs text-muted whitespace-pre-wrap break-words pt-2 border-t border-border"
          dangerouslySetInnerHTML={{
            __html: renderSlackMrkdwn(fields.notes),
          }}
        />
      ) : null}

      {!hasAnyField ? (
        <div
          className="text-sm text-fg whitespace-pre-wrap break-words"
          dangerouslySetInnerHTML={{
            __html: renderSlackMrkdwn(parsed.body),
          }}
        />
      ) : null}
    </div>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted w-20 flex-shrink-0">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
        {children}
      </div>
    </div>
  );
}

/** Render a Channel-field value as a Slack deep-link when we can
 *  extract a channel ID from it; falls back to plain text otherwise.
 *  Stops click-propagation so the row's collapse handler doesn't fire
 *  when the user clicks the link. */
function ChannelValue({ raw }: { raw: string }) {
  const { id, display } = parseChannelValue(raw);
  const href = id ? slackChannelUrl(id) : null;
  if (!href) {
    return <span className="text-sm text-fg">{display}</span>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="text-sm text-accent hover:underline"
      title={`Open ${display} in Slack`}
    >
      {display}
    </a>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-surface-2 text-fg text-xs border border-border">
      <span
        aria-hidden
        className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0"
      />
      <span>{children}</span>
    </span>
  );
}

/**
 * Parse a Slack feature-update post into a (name, body) pair.
 *
 * Fuzzy match for "feature name" anywhere on a line — case-insensitive,
 * ignoring Slack mrkdwn emphasis markers (`*_~``), markdown header
 * decoration (`#`), blockquote / bullet prefixes (`> -`), and leading
 * emoji / non-word characters. So all of these find "ODA Ad Offers
 * Capped at 7" as the name:
 *
 *   `Feature Name`                                  → next-line value
 *   `Feature Name: ODA Ad Offers Capped at 7`       → inline value
 *   `*Feature Name:* ODA Ad Offers Capped at 7`     → bold + inline
 *   `🚀 Feature Name`                              → emoji prefix
 *   `# Feature Name`                                → header prefix
 *   `> Feature Name`                                → blockquote
 *   `**Feature Name**`                              → markdown bold
 *
 * Returns null when the post truly doesn't mention "feature name" so
 * threads + chatter still get filtered out of the panel.
 */
function parseFeatureUpdate(
  text: string
): { name: string; body: string } | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // Pre-strip mrkdwn / decoration before matching so the regex
    // doesn't need to account for every variant.
    const stripped = lines[i]
      .replace(/[*_~`]/g, "") // emphasis markers
      .trim()
      .replace(/^[#>\-•·]+\s*/, "") // header / blockquote / bullet
      .replace(/^(:[a-z0-9_+\-]+:\s*)+/i, "") // Slack :emoji: shortcodes
      .replace(/^[^\w]+/u, "") // leading unicode emoji / non-word
      .trim();

    // Match "feature name" optionally followed by a separator
    // (colon / dash / period / whitespace) and the value.
    const m = /^feature\s*name\s*[:.\-—]?\s*(.*)$/i.exec(stripped);
    if (!m) continue;

    // Case 1: value on the same line ("Feature Name: ODA Ad Offers…").
    const inlineName = cleanValue(m[1]);
    if (inlineName) {
      const body = lines.filter((_, idx) => idx !== i).join("\n").trim();
      return { name: inlineName, body };
    }

    // Case 2: label-only line, value on the next non-blank line.
    for (let j = i + 1; j < lines.length; j++) {
      const value = cleanValue(lines[j]);
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

/** Strip mrkdwn emphasis + leading/trailing decoration from a name
 *  candidate so the displayed title is clean. */
function cleanValue(raw: string): string {
  return raw
    .replace(/[*_~`]/g, "")
    .replace(/^[#>\-•·]+\s*/, "")
    .trim();
}

// ─── Field extraction ─────────────────────────────────────────────────
// The team's posts under `*Feature Name*` follow a labeled-section
// convention: each section is a short label line followed by content
// lines. We split on that convention and bucket known labels (plan,
// roles, location, etc.) into a canonical shape so the card renderer
// can lay them out as chips / inline values / link buttons rather
// than as a wall of preformatted text.

interface ParsedFields {
  /** Free-text description paragraph. */
  description?: string;
  /** "Plan Availability" — array of tier names. */
  plan?: string[];
  /** "User Role Availability" — array of role names. */
  roles?: string[];
  /** "Location in app". */
  location?: string;
  /** "Product Manager". */
  product_manager?: string;
  /** "Project Channel". */
  channel?: string;
  /** All URLs harvested from the post (Resources/links field +
   *  anywhere else they appeared). Deduped, original order. */
  resources: string[];
  /** "Anything else we should know?" — catch-all prose. */
  notes?: string;
  /** Labeled sections we didn't recognize. Kept under their original
   *  label so nothing gets silently dropped. */
  other: Array<{ label: string; value: string }>;
}

/** Crude "is this a label line?" check: short, no URLs, doesn't end
 *  with sentence punctuation. We also keep ? and : as OK endings since
 *  "Anything else we should know?" is a real label. */
function looksLikeLabel(trimmed: string): boolean {
  if (trimmed.length === 0 || trimmed.length > 60) return false;
  if (/https?:\/\//i.test(trimmed)) return false;
  if (/[.!,;]$/.test(trimmed)) return false;
  return true;
}

/** Split a body into ordered label/value pairs + a fallback bucket for
 *  any content that didn't belong to a labeled section. */
function splitLabeledSections(body: string): {
  ordered: Array<{ label: string; value: string }>;
  fallback: string;
} {
  // Strip Slack emphasis markers globally so labels match cleanly.
  const lines = body.split("\n").map((l) => l.replace(/[*_~`]/g, ""));
  const ordered: Array<{ label: string; value: string }> = [];
  const fallbackLines: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    if (!looksLikeLabel(trimmed)) {
      fallbackLines.push(line);
      i++;
      continue;
    }

    // Look ahead for the first non-blank line — that's the start of
    // this section's value. If there isn't one, treat the current line
    // as fallback content (label without value isn't useful).
    let firstValueIdx = i + 1;
    while (firstValueIdx < lines.length && !lines[firstValueIdx].trim()) {
      firstValueIdx++;
    }
    if (firstValueIdx >= lines.length) {
      fallbackLines.push(line);
      i++;
      continue;
    }

    // Collect value lines until we hit a blank line followed by another
    // label, or EOF. Blank lines INSIDE a multi-paragraph value get
    // preserved so e.g. a long Description with paragraphs survives.
    const valueLines: string[] = [];
    let j = firstValueIdx;
    while (j < lines.length) {
      const here = lines[j].trim();

      if (!here) {
        // Peek past any blank stretch.
        let peek = j + 1;
        while (peek < lines.length && !lines[peek].trim()) peek++;
        if (peek >= lines.length) {
          j = peek;
          break;
        }
        if (looksLikeLabel(lines[peek].trim())) {
          // Next section starts; end this value.
          j = peek;
          break;
        }
        // Mid-value blank — keep one as a paragraph break.
        valueLines.push("");
        j = peek;
        continue;
      }

      valueLines.push(lines[j]);
      j++;
    }

    const value = valueLines.join("\n").trim();
    if (value) {
      ordered.push({ label: trimmed, value });
      i = j;
    } else {
      fallbackLines.push(line);
      i++;
    }
  }

  return {
    ordered,
    fallback: fallbackLines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
  };
}

const KNOWN_LABEL_MATCHERS: Array<{
  key:
    | "description"
    | "resources"
    | "location"
    | "plan"
    | "roles"
    | "pm"
    | "channel"
    | "notes";
  matches: RegExp;
}> = [
  { key: "description", matches: /^description$/i },
  // "Resources/links (Loom, figma, KB)" and variants
  { key: "resources", matches: /^resources?(\s*[/\-]\s*links?)?(\s*\([^)]*\))?$/i },
  { key: "location", matches: /^location(\s+in\s+(the\s+)?app)?$/i },
  { key: "plan", matches: /^plan(\s+availability)?$/i },
  {
    key: "roles",
    matches: /^(user\s+)?roles?(\s+availability)?$/i,
  },
  { key: "pm", matches: /^product\s+manager$/i },
  { key: "channel", matches: /^(project\s+)?channel$/i },
  // "Anything else we should know?" and similar
  { key: "notes", matches: /^anything\s+else.*$/i },
];

function canonicalKey(label: string): (typeof KNOWN_LABEL_MATCHERS)[number]["key"] | null {
  for (const { key, matches } of KNOWN_LABEL_MATCHERS) {
    if (matches.test(label)) return key;
  }
  return null;
}

/** Extract URLs from a chunk of text. Handles Slack's `<url|label>`
 *  and `<url>` wrappers as well as bare URLs. Returns each URL at most
 *  once, in source order. */
function extractUrls(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const slackWrapped = /<(https?:\/\/[^|>\s]+)(?:\|[^>]+)?>/g;
  const bare = /(?<![<"'])(https?:\/\/[^\s<>"']+)/g;
  let m: RegExpExecArray | null;
  while ((m = slackWrapped.exec(text)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      found.push(m[1]);
    }
  }
  while ((m = bare.exec(text)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      found.push(m[1]);
    }
  }
  return found;
}

/** Split a comma/slash/' and '-separated chip list into individual
 *  entries. Falls back to a single chip when no separator is detected. */
function splitChips(value: string): string[] {
  return value
    .split(/\s*(?:,|\/|\sand\s)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The Channel field in a feature-update post is a Slack channel ref.
 *  It can land in our parser as any of these shapes:
 *    - Plain ID: "C093C6MDS1E"
 *    - Slack mrkdwn ref: "<#C093C6MDS1E|feature-updates>"
 *    - Archive URL: "https://beehiiv.slack.com/archives/C093C6MDS1E"
 *    - Plain text: "private channel" (no ID — render as-is)
 *  We normalize to a {id?, display} pair and let the renderer decide
 *  whether to make it a link. */
function parseChannelValue(raw: string): { id?: string; display: string } {
  const trimmed = raw.trim();

  // Slack mrkdwn channel reference — includes the friendly name.
  const mrkdwnRef = /^<#([CGD][A-Z0-9]{6,})\|([^>]+)>$/.exec(trimmed);
  if (mrkdwnRef) {
    return { id: mrkdwnRef[1], display: `#${mrkdwnRef[2]}` };
  }

  // Bare channel ID — no friendly name available.
  if (/^[CGD][A-Z0-9]{6,}$/.test(trimmed)) {
    return { id: trimmed, display: `#${trimmed}` };
  }

  // Slack archive URL.
  const archiveUrl = /^https?:\/\/[^/]*\.slack\.com\/archives\/([CGD][A-Z0-9]{6,})/.exec(
    trimmed
  );
  if (archiveUrl) {
    return { id: archiveUrl[1], display: `#${archiveUrl[1]}` };
  }

  return { display: trimmed };
}

/** Friendly icon + label for a URL based on its host. Fallback is the
 *  bare hostname so an unknown link still reads better than "🔗". */
function urlIcon(url: string): { icon: string; label: string } {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (host.includes("loom.com")) return { icon: "🎥", label: "Loom" };
    if (host.includes("figma.com")) return { icon: "🎨", label: "Figma" };
    if (host.includes("notion.so")) return { icon: "📝", label: "Notion" };
    if (host.includes("metabase")) return { icon: "📊", label: "Metabase" };
    if (host.includes("linear.app")) return { icon: "📋", label: "Linear" };
    if (host.includes("docs.google.com")) return { icon: "📄", label: "Google Doc" };
    if (host.includes("sheets.google.com")) return { icon: "📊", label: "Google Sheet" };
    if (host.includes("slides.google.com")) return { icon: "📈", label: "Google Slides" };
    if (host.includes("github.com")) return { icon: "🐙", label: "GitHub" };
    if (host.includes("slack.com")) return { icon: "💬", label: "Slack" };
    if (host.includes("beehiiv.com")) return { icon: "🐝", label: "beehiiv" };
    if (host.includes("youtube.com") || host.includes("youtu.be"))
      return { icon: "📺", label: "YouTube" };
    return { icon: "🔗", label: host };
  } catch {
    return { icon: "🔗", label: "Link" };
  }
}

/** Top-level parser: turn the post body into the structured shape the
 *  card renderer expects. Always returns an object — empty fields just
 *  mean nothing to render in that slot. */
function parseFields(body: string): ParsedFields {
  const { ordered, fallback } = splitLabeledSections(body);
  const result: ParsedFields = { resources: [], other: [] };
  const resourceUrlsSeen = new Set<string>();
  const notesParts: string[] = [];

  if (fallback) notesParts.push(fallback);

  /** Track URLs we've already harvested so each resource button is
   *  unique. Defined inside parseFields so it can close over the
   *  result object. */
  function addResources(urls: string[]) {
    for (const url of urls) {
      if (!resourceUrlsSeen.has(url)) {
        resourceUrlsSeen.add(url);
        result.resources.push(url);
      }
    }
  }

  for (const { label, value } of ordered) {
    const key = canonicalKey(label);
    switch (key) {
      case "description":
        result.description = value;
        addResources(extractUrls(value));
        break;
      case "resources":
        addResources(extractUrls(value));
        // If the value had any non-URL prose, keep it under Notes so
        // the author's hand-written caption isn't dropped.
        {
          const stripped = value.replace(/<?https?:\/\/[^\s<>|]+(?:\|[^>]+)?>?/g, "").trim();
          if (stripped) notesParts.push(`${label}: ${stripped}`);
        }
        break;
      case "location":
        result.location = value;
        break;
      case "plan":
        result.plan = splitChips(value);
        break;
      case "roles":
        result.roles = splitChips(value);
        break;
      case "pm":
        result.product_manager = value;
        break;
      case "channel":
        result.channel = value;
        break;
      case "notes":
        notesParts.push(value);
        // URLs inside "Anything else…" content (e.g. "A/B Stats: <url>")
        // get lifted into Resources too so readers see them as a
        // clickable chip rather than only inline in the prose.
        addResources(extractUrls(value));
        break;
      case null:
        result.other.push({ label, value });
        // Still pluck any URLs so they surface as resource chips.
        addResources(extractUrls(value));
        break;
    }
  }

  // Last-mile sweep: also extract URLs from the fallback (unlabeled)
  // content so a bare URL hanging at the bottom of a post still
  // surfaces as a Resources chip.
  if (fallback) addResources(extractUrls(fallback));

  if (notesParts.length > 0) {
    result.notes = notesParts.join("\n\n").trim();
  }

  return result;
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
