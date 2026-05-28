"use client";

import { useEffect, useMemo, useState } from "react";
import type { StoredTemplate } from "@/lib/templates/types";
import { isVisibleToCsm } from "@/lib/templates/types";
import { useViewerEmail } from "@/lib/auth-client";
import { applyMergeTags } from "@/lib/templates/merge-tags";
import { htmlToText } from "@/lib/templates/bulk-drafts";
import { gmailComposeUrl } from "@/lib/links";
import type { Customer } from "@/lib/types";
import type { SettingsShape } from "@/lib/data/settings-types";

/**
 * Bulk-outreach for the Below $3.5K ARR past-due tier. Per the AM
 * Hackathon brief, this flow differs from the Enterprise / Above
 * $3.5K cases in two ways:
 *
 *   1. Sender — drafts go out via a designated email alias (set in
 *      /settings/general → `am.bulk_alias_email`), not the user's
 *      primary Gmail.
 *   2. Recipients — instead of one draft per customer, the customer
 *      list is split into batches of N (default 40) and each batch
 *      becomes ONE draft with the customers in BCC. Recipients never
 *      see each other.
 *
 * The merge-tag layer is template-rendered against the FIRST customer
 * in each batch (since merge tags need a "subject" customer to resolve
 * tier/ARR/etc. tokens), but the body is intended to be generic —
 * admins should use templates without per-customer tokens here.
 *
 * Opens N Gmail compose tabs (one per batch) on click. The user
 * reviews and clicks Send in Gmail; nothing is sent automatically.
 *
 * Side-effect: after a successful click-through we mark every customer
 * in the batch as `status: "touched"` in the past-due-outreach KV
 * (via PUT /api/past-due/outreach) so the Follow-Up tab knows who's
 * already been touched.
 */

interface Props {
  customers: Customer[];
  settings: SettingsShape | null;
  /** Optional disabled override — typically `customers.length === 0`. */
  disabled?: boolean;
  /** Callback fired after the user has confirmed the batch send and we
   *  recorded the touched status — lets the parent panel refresh. */
  onSent?: (customerIds: string[]) => void;
}

export function LowTierBulkSend({
  customers,
  settings,
  disabled = false,
  onSent,
}: Props) {
  const viewerEmail = useViewerEmail();
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<StoredTemplate[]>([]);
  const [templateId, setTemplateId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  const [markMessage, setMarkMessage] = useState<string | null>(null);

  const batchSize = Math.max(
    1,
    Math.min(99, settings?.am?.bulk_bcc_batch_size ?? 40)
  );
  const aliasEmail = (settings?.am?.bulk_alias_email ?? "").trim();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch("/api/templates")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as StoredTemplate[];
      })
      .then((all) => {
        if (cancelled) return;
        const visible = all.filter((t) => isVisibleToCsm(t, viewerEmail));
        setTemplates(visible);
        const tpl =
          visible.find((t) => t.id === "general-checkin") ?? visible[0];
        setTemplateId(tpl?.id ?? "");
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unknown");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, viewerEmail]);

  /** Split the customer list into BCC batches of `batchSize`. Last batch
   *  may be shorter. */
  const batches = useMemo(() => {
    const out: Customer[][] = [];
    for (let i = 0; i < customers.length; i += batchSize) {
      out.push(customers.slice(i, i + batchSize));
    }
    return out;
  }, [customers, batchSize]);

  const template = templates.find((t) => t.id === templateId) ?? null;

  function buildBatchComposeUrl(batch: Customer[]): string | null {
    if (!template) return null;
    // Merge-tag context is the FIRST customer in the batch. Templates
    // for this flow should avoid per-customer tokens; if they include
    // them they'll render against this one customer's values for the
    // whole batch. The "generic" templates shipped (general-checkin)
    // don't use per-customer tokens, so this is a safe default.
    const anchor = batch[0];
    const subject = applyMergeTags(template.subject, anchor, {});
    const body = htmlToText(applyMergeTags(template.body_html, anchor, {}));
    const bcc = batch
      .map((c) => c.owner_email)
      .filter((e): e is string => Boolean(e))
      .join(", ");
    return gmailComposeUrl({
      to: aliasEmail || "",
      bcc,
      subject,
      body,
    });
  }

  async function openAll() {
    if (batches.length === 0) return;
    let opened = 0;
    for (const batch of batches) {
      const url = buildBatchComposeUrl(batch);
      if (!url) continue;
      const w = window.open(url, "_blank");
      if (w) opened++;
    }
    if (opened < batches.length) {
      setError(
        `Browser blocked ${batches.length - opened} compose tab${
          batches.length - opened === 1 ? "" : "s"
        }. Use the per-batch buttons below.`
      );
    } else {
      setError(null);
    }
    // After opening, immediately mark every customer touched. We don't
    // confirm "did the user actually send" — that'd require Gmail API
    // polling. Sending is implicit on a compose tab open + Send click.
    await markAllTouched();
  }

  async function markAllTouched() {
    const ids = customers
      .map((c) => c.stripe_customer_id)
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) return;
    setMarking(true);
    setMarkMessage(null);
    try {
      const r = await fetch("/api/past-due/outreach", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_ids: ids, status: "touched" }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setMarkMessage(
        `Marked ${ids.length} customer${ids.length === 1 ? "" : "s"} as touched.`
      );
      onSent?.(ids);
    } catch (e) {
      setMarkMessage(
        `Touched-status save failed: ${e instanceof Error ? e.message : "unknown"}`
      );
    } finally {
      setMarking(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        disabled={disabled || customers.length === 0}
        className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
        title="Bulk-BCC up to 40 customers per draft from the configured alias address"
      >
        ✉️ Bulk send (BCC {batchSize}/batch)
      </button>
      {open ? (
        <div
          className="fixed inset-0 bg-black/40 z-40 flex items-center justify-center p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-surface rounded-lg w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between p-4 border-b border-border gap-3">
              <div className="min-w-0">
                <h3 className="font-semibold text-fg">
                  Bulk outreach: Below $3.5K ARR
                </h3>
                <p className="text-xs text-muted mt-0.5">
                  {customers.length} customer
                  {customers.length === 1 ? "" : "s"} →{" "}
                  <strong className="text-fg">{batches.length}</strong> draft
                  {batches.length === 1 ? "" : "s"} of up to {batchSize} BCCs
                  each
                </p>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="text-subtle hover:text-muted text-xl leading-none flex-shrink-0"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="p-4 space-y-3 overflow-y-auto flex-1">
              {!aliasEmail ? (
                <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-md p-3 text-sm text-amber-900 dark:text-amber-200">
                  <strong>No alias configured.</strong> Drafts will use your
                  primary Gmail until an admin sets{" "}
                  <code className="font-mono bg-amber-100 dark:bg-amber-500/20 px-1 rounded">
                    am.bulk_alias_email
                  </code>{" "}
                  in /settings/general.
                </div>
              ) : (
                <div className="text-xs text-muted">
                  From:{" "}
                  <span className="text-fg font-mono">{aliasEmail}</span> · BCC
                  list per batch, no per-customer merge tags.
                </div>
              )}

              <label className="text-xs text-muted block">
                Template
                <select
                  value={templateId}
                  onChange={(e) => setTemplateId(e.target.value)}
                  disabled={loading || templates.length === 0}
                  className="block mt-1 w-full px-2 py-1.5 border border-border-strong rounded-md text-sm bg-surface"
                >
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>

              {error ? (
                <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-md p-3 text-sm text-red-800 dark:text-red-300">
                  {error}
                </div>
              ) : null}
              {markMessage ? (
                <div className="text-xs text-muted">{markMessage}</div>
              ) : null}

              <div className="border border-border rounded-md overflow-hidden">
                <div className="bg-canvas px-3 py-2 border-b border-border text-xs font-medium text-muted">
                  Batches
                </div>
                <ul className="divide-y divide-border">
                  {batches.map((batch, i) => (
                    <li
                      key={i}
                      className="px-3 py-2 flex items-center justify-between gap-3 hover:bg-canvas/40"
                    >
                      <div className="min-w-0">
                        <p className="text-sm text-fg">
                          Batch {i + 1} of {batches.length} —{" "}
                          {batch.length} recipient
                          {batch.length === 1 ? "" : "s"}
                        </p>
                        <p className="text-[11px] text-muted truncate font-mono">
                          {batch
                            .map((c) => c.owner_email ?? "—")
                            .filter(Boolean)
                            .slice(0, 3)
                            .join(", ")}
                          {batch.length > 3 ? `, +${batch.length - 3} more` : ""}
                        </p>
                      </div>
                      <a
                        href={buildBatchComposeUrl(batch) ?? "#"}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs px-2 py-1 border border-border-strong rounded-md hover:bg-canvas flex-shrink-0"
                      >
                        Open
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="p-4 border-t border-border flex items-center justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas"
              >
                Cancel
              </button>
              <button
                onClick={openAll}
                disabled={loading || marking || batches.length === 0 || !template}
                className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
              >
                {marking
                  ? "Saving touched status…"
                  : `Open all ${batches.length} draft${
                      batches.length === 1 ? "" : "s"
                    }`}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
