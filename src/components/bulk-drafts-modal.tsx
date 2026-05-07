"use client";

import { useEffect, useState } from "react";

export interface BulkDraft {
  customer_label: string;
  to: string;
  subject: string;
  body_text: string;
  /** Rich-HTML body — Gmail API drafts use this; CSV/Open-in-Gmail fall back to body_text. */
  body_html?: string;
  compose_url: string;
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

interface Props {
  templateLabel: string;
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
  templateLabel,
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
    for (const d of drafts) {
      const w = window.open(d.compose_url, "_blank", "noopener,noreferrer");
      if (w) opened++;
    }
    setOpenedCount(opened);
  }

  function downloadCsv() {
    const header = ["email", "subject", "body"].join(",");
    const lines = drafts.map((d) =>
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
    if (drafts.length === 0) return;
    setGmailBusy(true);
    setGmailMessage(null);
    try {
      const r = await fetch("/api/drafts/bulk-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          drafts: drafts.map((d) => ({
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

  async function copy(d: BulkDraft) {
    try {
      await navigator.clipboard.writeText(
        `To: ${d.to}\nSubject: ${d.subject}\n\n${d.body_text}`
      );
      setCopyHit(d.compose_url);
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
        className="bg-white rounded-lg w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-4 border-b border-gray-200">
          <div>
            <h3 className="font-semibold text-gray-900">
              Bulk drafts ({drafts.length})
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Template: <code className="font-mono px-1 bg-gray-100 rounded">{templateLabel}</code>.
              Click <strong>Open all</strong> to launch every draft in a new
              tab, or open them individually below.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {gmail?.connected ? (
              <button
                onClick={createGmailDrafts}
                disabled={loading || drafts.length === 0 || gmailBusy}
                className="px-3 py-1.5 bg-gray-900 text-white rounded-md text-sm font-medium hover:bg-gray-700 disabled:opacity-50"
              >
                {gmailBusy
                  ? "Creating drafts…"
                  : `📥 Create ${drafts.length} drafts in ${gmail.email ?? "Gmail"}`}
              </button>
            ) : (
              <a
                href="/api/auth/google/start"
                className="px-3 py-1.5 bg-gray-900 text-white rounded-md text-sm font-medium hover:bg-gray-700"
                title="Connect Gmail to create drafts directly without opening tabs"
              >
                Connect Gmail to create drafts directly
              </a>
            )}
            <button
              onClick={downloadCsv}
              disabled={loading || drafts.length === 0}
              className="px-3 py-1.5 border border-gray-300 rounded-md text-sm hover:bg-gray-50 disabled:opacity-50"
              title="Download a CSV of every draft (email/subject/body) for use with mail-merge tools like YAMM."
            >
              ⬇ Download CSV
            </button>
            <button
              onClick={openAll}
              disabled={loading || drafts.length === 0}
              className="px-3 py-1.5 border border-gray-300 rounded-md text-sm hover:bg-gray-50 disabled:opacity-50"
            >
              Open all in Gmail tabs
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-gray-600">
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
          <div className="m-4 bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-800">
            {error}
          </div>
        ) : null}

        <div className="overflow-y-auto flex-1 divide-y divide-gray-100">
          {drafts.length === 0 && !loading ? (
            <p className="p-4 text-sm text-gray-500">No drafts to show.</p>
          ) : null}
          {drafts.map((d) => (
            <div
              key={d.compose_url}
              className="p-3 hover:bg-gray-50/60 flex items-start gap-3"
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-900 truncate">
                  {d.customer_label}
                </div>
                <div className="text-xs text-gray-500 truncate">
                  To: {d.to}
                </div>
                <div className="text-xs text-gray-700 mt-1 truncate">
                  {d.subject}
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => copy(d)}
                  className="px-2 py-1 text-xs border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  {copyHit === d.compose_url ? "Copied" : "Copy"}
                </button>
                <a
                  href={d.compose_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-2 py-1 text-xs bg-gray-900 text-white rounded-md hover:bg-gray-700"
                >
                  Open
                </a>
              </div>
            </div>
          ))}
        </div>

        <div className="px-4 py-3 border-t border-gray-200 flex justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1.5 border border-gray-300 rounded-md text-sm hover:bg-gray-50"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
