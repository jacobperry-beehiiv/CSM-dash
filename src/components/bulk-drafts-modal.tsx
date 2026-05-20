"use client";

import { useEffect, useMemo, useState } from "react";

export interface BulkDraftRecipient {
  email: string;
  name: string | null;
  /** True for the customer's owner_email (default-checked). */
  default: boolean;
}

export interface BulkDraft {
  customer_label: string;
  /** Default recipient list (the customer's owner_email when present),
   *  used as the initial selection when the modal first renders.
   *  Comma-separated to match how a Gmail compose `to=` field is built. */
  to: string;
  subject: string;
  body_text: string;
  /** Rich-HTML body — Gmail API drafts use this; CSV/Open-in-Gmail fall back to body_text. */
  body_html?: string;
  /** Compose URL with the *default* `to` baked in. The modal recomputes
   *  this live whenever the user toggles recipients. */
  compose_url: string;
  /** Every viable recipient for this customer (owner_email + every
   *  HubSpot contact whose primary associated company is this one).
   *  The modal lets the user check/uncheck each before opening tabs /
   *  creating Gmail drafts. */
  recipients: BulkDraftRecipient[];
}

function buildGmailComposeUrl(
  to: string,
  subject: string,
  body: string
): string {
  const params = new URLSearchParams({ view: "cm", fs: "1", to, su: subject, body });
  return `https://mail.google.com/mail/?${params.toString()}`;
}

function csvEscape(s: string): string {
  if (s == null) return "";
  // Always quote — keeps subject lines with commas safe.
  return `"${String(s).replace(/"/g, '""')}"`;
}

function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

interface GmailStatus {
  connected: boolean;
  email?: string | null;
}

interface TemplateOption {
  id: string;
  label: string;
}

interface Props {
  templates: TemplateOption[];
  templateId: string;
  onTemplateChange: (id: string) => void;
  drafts: BulkDraft[];
  loading: boolean;
  loadingProgress: { done: number; total: number } | null;
  error: string | null;
  onClose: () => void;
}

/**
 * Drafts queue modal. Shown after the user clicks "Draft for N" so the
 * browser popup blocker doesn't silently swallow most of the tabs.
 *
 * Strategy:
 *   1. Render every pre-built draft in a list.
 *   2. "Open all" tries to fire window.open() for every URL synchronously
 *      inside a single click handler — most browsers allow ~6-20 tabs from
 *      one gesture. Shows how many succeeded.
 *   3. Per-row buttons let the user open / copy any draft that got blocked
 *      or that they want to review individually.
 */
export function BulkDraftsModal({
  templates,
  templateId,
  onTemplateChange,
  drafts,
  loading,
  loadingProgress,
  error,
  onClose,
}: Props) {
  const [openedCount, setOpenedCount] = useState<number | null>(null);
  const [copyHit, setCopyHit] = useState<string | null>(null);
  const [gmail, setGmail] = useState<GmailStatus | null>(null);
  const [gmailBusy, setGmailBusy] = useState(false);
  const [gmailMessage, setGmailMessage] = useState<string | null>(null);
  // Per-draft recipient selection. Keyed by the draft's compose_url
  // (stable across re-renders for a single open-of-modal). Set of
  // lowercased email addresses.
  const [recipientSelection, setRecipientSelection] = useState<
    Record<string, Set<string>>
  >({});
  // Which drafts have the recipient list expanded inline.
  const [expandedRecipients, setExpandedRecipients] = useState<Set<string>>(
    new Set()
  );
  // Which drafts have the body preview expanded. Separate from
  // recipient expansion so the CSM can review the body without
  // dismissing the recipient picker.
  const [expandedBodies, setExpandedBodies] = useState<Set<string>>(
    new Set()
  );

  function toggleBody(draftKey: string) {
    setExpandedBodies((prev) => {
      const next = new Set(prev);
      if (next.has(draftKey)) next.delete(draftKey);
      else next.add(draftKey);
      return next;
    });
  }

  // Initialise selection from each draft's default recipients when the
  // drafts list arrives / changes. Drafts already-keyed are preserved so
  // a user's manual toggles survive a template re-render.
  useEffect(() => {
    setRecipientSelection((prev) => {
      const next = { ...prev };
      for (const d of drafts) {
        if (next[d.compose_url]) continue;
        const defaults = d.recipients
          .filter((r) => r.default)
          .map((r) => r.email.toLowerCase());
        // Fallback: if nothing is marked default, pick the first recipient.
        const seed =
          defaults.length > 0
            ? defaults
            : d.recipients[0]
              ? [d.recipients[0].email.toLowerCase()]
              : [];
        next[d.compose_url] = new Set(seed);
      }
      return next;
    });
  }, [drafts]);

  /** Resolve the live `to:` string (comma-separated) for a draft based
   *  on current selection state. Falls back to the draft's stored `to`
   *  when no selection has been initialised yet. */
  function liveTo(d: BulkDraft): string {
    const sel = recipientSelection[d.compose_url];
    if (!sel) return d.to;
    const emails = d.recipients
      .filter((r) => sel.has(r.email.toLowerCase()))
      .map((r) => r.email);
    return emails.join(", ");
  }

  function liveComposeUrl(d: BulkDraft): string {
    const to = liveTo(d);
    if (!to) return d.compose_url;
    return buildGmailComposeUrl(to, d.subject, d.body_text);
  }

  function toggleRecipient(draftKey: string, email: string) {
    const e = email.toLowerCase();
    setRecipientSelection((prev) => {
      const next = { ...prev };
      const cur = new Set(next[draftKey] ?? []);
      if (cur.has(e)) cur.delete(e);
      else cur.add(e);
      next[draftKey] = cur;
      return next;
    });
  }

  function toggleExpand(draftKey: string) {
    setExpandedRecipients((prev) => {
      const next = new Set(prev);
      if (next.has(draftKey)) next.delete(draftKey);
      else next.add(draftKey);
      return next;
    });
  }

  /** Drafts the user actually wants to act on right now — at least one
   *  selected recipient. Used by every "send to all" path so unchecking
   *  every recipient excludes the draft entirely. */
  const actionableDrafts = useMemo(
    () =>
      drafts
        .map((d) => ({ ...d, to: liveTo(d), compose_url: liveComposeUrl(d) }))
        .filter((d) => d.to.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drafts, recipientSelection]
  );

  // Lazy-load Gmail connection status when the modal mounts
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/google/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (!cancelled) setGmail(s as GmailStatus);
      })
      .catch(() => {
        if (!cancelled) setGmail({ connected: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function openAll() {
    let opened = 0;
    for (const d of actionableDrafts) {
      const w = window.open(d.compose_url, "_blank", "noopener,noreferrer");
      if (w) opened++;
    }
    setOpenedCount(opened);
  }

  function downloadCsv() {
    const header = ["email", "subject", "body"].join(",");
    const lines = actionableDrafts.map((d) =>
      [csvEscape(d.to), csvEscape(d.subject), csvEscape(d.body_text)].join(",")
    );
    const ts = new Date().toISOString().slice(0, 10);
    downloadFile(
      `bulk-drafts-${ts}.csv`,
      [header, ...lines].join("\n"),
      "text/csv;charset=utf-8"
    );
  }

  async function createGmailDrafts() {
    if (actionableDrafts.length === 0) return;
    setGmailBusy(true);
    setGmailMessage(null);
    try {
      const r = await fetch("/api/drafts/bulk-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          drafts: actionableDrafts.map((d) => ({
            to: d.to,
            subject: d.subject,
            body_html: d.body_html ?? d.body_text,
          })),
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      const where = j.created_in ?? gmail?.email ?? "your Gmail";
      setGmailMessage(
        `Created ${j.created} draft${j.created === 1 ? "" : "s"} in ${where}'s Drafts folder${
          j.failed > 0 ? ` (${j.failed} failed)` : ""
        }.`
      );
    } catch (e) {
      setGmailMessage(
        `Gmail draft creation failed: ${
          e instanceof Error ? e.message : "unknown"
        }`
      );
    } finally {
      setGmailBusy(false);
    }
  }

  async function copy(d: BulkDraft, hitKey: string) {
    try {
      await navigator.clipboard.writeText(
        `To: ${d.to}\nSubject: ${d.subject}\n\n${d.body_text}`
      );
      setCopyHit(hitKey);
      setTimeout(() => setCopyHit(null), 1200);
    } catch {
      /* clipboard blocked — silent */
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 z-30 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-4 border-b border-border gap-4">
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-fg">
              Bulk drafts ({drafts.length})
            </h3>
            <div className="flex items-center gap-2 mt-1.5">
              <label
                htmlFor="bulk-template-select"
                className="text-xs text-muted whitespace-nowrap"
              >
                Template:
              </label>
              <select
                id="bulk-template-select"
                value={templateId}
                onChange={(e) => onTemplateChange(e.target.value)}
                disabled={loading || templates.length === 0}
                className="text-xs px-2 py-1 border border-border-strong rounded-md bg-surface max-w-full disabled:opacity-50"
              >
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-subtle hover:text-muted text-xl leading-none flex-shrink-0"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-4 py-3 border-b border-border bg-canvas space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {gmail?.connected ? (
              <button
                onClick={createGmailDrafts}
                disabled={loading || actionableDrafts.length === 0 || gmailBusy}
                className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
              >
                {gmailBusy
                  ? "Creating drafts…"
                  : `📥 Create ${actionableDrafts.length} drafts in ${gmail.email ?? "Gmail"}`}
              </button>
            ) : (
              <a
                href="/api/auth/google/start"
                className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover"
                title="Connect Gmail to create drafts directly without opening tabs"
              >
                Connect Gmail to create drafts directly
              </a>
            )}
            <button
              onClick={downloadCsv}
              disabled={loading || actionableDrafts.length === 0}
              className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas disabled:opacity-50"
              title="Download a CSV of every draft (email/subject/body) for use with mail-merge tools like YAMM."
            >
              ⬇ Download CSV
            </button>
            <button
              onClick={openAll}
              disabled={loading || actionableDrafts.length === 0}
              className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas disabled:opacity-50"
            >
              Open all in Gmail tabs
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
            {loading && loadingProgress ? (
              <span>
                Building drafts… {loadingProgress.done}/{loadingProgress.total}
              </span>
            ) : null}
            {openedCount != null ? (
              <span>
                Browser opened {openedCount} of {drafts.length} tabs.
                {openedCount < drafts.length ? (
                  <> The rest were blocked — open them individually below.</>
                ) : null}
              </span>
            ) : null}
            {gmailMessage ? <span>{gmailMessage}</span> : null}
          </div>
        </div>

        {error ? (
          <div className="m-4 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-md p-3 text-sm text-red-800 dark:text-red-300">
            {error}
          </div>
        ) : null}

        <div className="overflow-y-auto flex-1 divide-y divide-border">
          {drafts.length === 0 && !loading ? (
            <p className="p-4 text-sm text-muted">No drafts to show.</p>
          ) : null}
          {drafts.map((d) => {
            const draftKey = d.compose_url;
            const sel = recipientSelection[draftKey] ?? new Set();
            const liveToStr = liveTo(d);
            const liveUrl = liveComposeUrl(d);
            const isExpanded = expandedRecipients.has(draftKey);
            const bodyOpen = expandedBodies.has(draftKey);
            const hasContactsBeyondDefault = d.recipients.some((r) => !r.default);
            return (
              <div key={draftKey} className="p-3 hover:bg-canvas/60">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-fg truncate">
                      {d.customer_label}
                    </div>
                    <div className="text-xs text-muted truncate flex items-center gap-1.5">
                      <span className="truncate">To: {liveToStr || "(none)"}</span>
                      {d.recipients.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => toggleExpand(draftKey)}
                          className="text-[10px] uppercase tracking-wide text-accent hover:underline whitespace-nowrap flex-shrink-0"
                          title="Toggle which contacts to include"
                        >
                          {isExpanded
                            ? "Hide"
                            : hasContactsBeyondDefault
                              ? `+${d.recipients.length - 1} contact${d.recipients.length - 1 === 1 ? "" : "s"}`
                              : "Edit"}
                        </button>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted mt-1 flex items-center gap-1.5 min-w-0">
                      <span className="truncate flex-1 min-w-0">
                        {d.subject}
                      </span>
                      <button
                        type="button"
                        onClick={() => toggleBody(draftKey)}
                        className="text-[10px] uppercase tracking-wide text-accent hover:underline whitespace-nowrap flex-shrink-0"
                        title="Toggle the rendered email body preview"
                      >
                        {bodyOpen ? "Hide body" : "Preview body"}
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() =>
                        copy(
                          { ...d, to: liveToStr, compose_url: liveUrl },
                          draftKey
                        )
                      }
                      className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas"
                    >
                      {copyHit === draftKey ? "Copied" : "Copy"}
                    </button>
                    <a
                      href={liveUrl}
                      onClick={(e) => {
                        if (!liveToStr) {
                          e.preventDefault();
                        }
                      }}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`px-2 py-1 text-xs rounded-md ${
                        liveToStr
                          ? "bg-accent text-accent-fg hover:bg-accent-hover"
                          : "bg-surface-2 text-subtle cursor-not-allowed"
                      }`}
                    >
                      Open
                    </a>
                  </div>
                </div>
                {isExpanded && d.recipients.length > 0 ? (
                  <ul className="mt-2 ml-1 grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1">
                    {d.recipients.map((r) => {
                      const checked = sel.has(r.email.toLowerCase());
                      return (
                        <li key={r.email} className="text-xs">
                          <label className="flex items-center gap-2 cursor-pointer py-0.5">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleRecipient(draftKey, r.email)}
                              className="h-3.5 w-3.5 rounded border-border-strong cursor-pointer"
                            />
                            <span className="truncate">
                              {r.name ? (
                                <>
                                  <span className="text-fg">{r.name}</span>
                                  <span className="text-subtle"> · </span>
                                </>
                              ) : null}
                              <span className="text-muted">{r.email}</span>
                              {r.default ? (
                                <span className="ml-1 text-[10px] uppercase tracking-wide text-subtle">
                                  owner
                                </span>
                              ) : null}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {bodyOpen ? (
                  /* Rendered HTML body the modal will create as a Gmail
                     draft (or open via the compose URL). Falls back to
                     the plain-text version when body_html is absent
                     (legacy callers). The block is sandboxed visually
                     with the same card chrome as the rest of the row so
                     it can't blow out layout. */
                  <div className="mt-2 ml-1 border border-border rounded-md bg-canvas/40 p-3">
                    {d.body_html ? (
                      <div
                        className="prose prose-sm max-w-none text-sm text-fg"
                        // Body templates are authored by trusted admins
                        // in /settings/templates; merge-tag values come
                        // from our own snapshot. This is the same
                        // dangerouslySetInnerHTML path the single-customer
                        // OutreachModal uses.
                        dangerouslySetInnerHTML={{ __html: d.body_html }}
                      />
                    ) : (
                      <pre className="whitespace-pre-wrap break-words text-sm text-fg font-sans">
                        {d.body_text}
                      </pre>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="px-4 py-3 border-t border-border flex justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
