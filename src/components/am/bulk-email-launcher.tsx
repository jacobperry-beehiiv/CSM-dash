"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BulkDraftsModal,
  type BulkDraft,
} from "../bulk-drafts-modal";
import {
  buildBulkDrafts,
  type BuildBulkDraftsInput,
} from "@/lib/templates/bulk-drafts";
import { isVisibleToCsm, type StoredTemplate } from "@/lib/templates/types";
import { useViewerEmail } from "@/lib/auth-client";
import { getTierLadder } from "@/lib/tiers/client";
import type { Customer } from "@/lib/types";
import type { EnterpriseTier } from "@/lib/tiers/store";

/**
 * Self-contained "Email selected" button for the AM dashboard tabs.
 * Hands the heavy lifting off to the existing <BulkDraftsModal> —
 * which already has per-row HubSpot-contact recipient toggles, live
 * preview, copy/open/Gmail-drafts actions — so AM tabs don't have
 * to reinvent any of that surface.
 *
 * On click:
 *   1. Fetches /api/templates + the tier ladder (visible templates
 *      narrowed to the current viewer via isVisibleToCsm).
 *   2. Picks a default template by id (caller supplies the preferred
 *      autoTemplateId — past-due defaults to "general-checkin",
 *      approaching to "approaching-ent").
 *   3. Builds N BulkDrafts via the shared buildBulkDrafts helper.
 *   4. Opens the modal with those drafts.
 *
 * Skips ad-gap pre-fetching that customer-table does — the AM
 * templates we ship don't reference `customer.ad_revenue_*` tokens,
 * and avoiding that fetch keeps the click-to-modal feel instant.
 */
interface Props {
  customers: Customer[];
  /** Preferred default template id. Falls back to "general-checkin"
   *  then the first available template. */
  defaultTemplateId?: string;
  /** Optional disabled override — typically `selectedCount === 0`. */
  disabled?: boolean;
  /** Label on the trigger button. Defaults to "✉️ Email selected". */
  label?: string;
  /** Per-customer CC resolver. Used by the Past Due Enterprise tier
   *  to CC the assigned CSM on every draft. Return null when the
   *  customer has no CC (the draft renders without CC then). */
  ccLookup?: (c: Customer) => string | null;
  /** Per-customer BCC resolver. Reserved for future flows. */
  bccLookup?: (c: Customer) => string | null;
  /** Pluck a tracking id off each customer (e.g. stripe_customer_id
   *  for past-due, workspace_id for proactive outreach). When set, the
   *  modal forwards these ids through to `onDraftCreated` after the
   *  user actions a batch — letting the caller stamp lifecycle state
   *  (touched / outreach_logged) automatically. */
  trackingIdFor?: (c: Customer) => string | null;
  /** Fired after the user opens compose tabs OR creates Gmail-API
   *  drafts. Receives the tracking_ids of every draft that got
   *  handled. */
  onDraftCreated?: (tracking_ids: string[]) => void;
  /** Pre-select this email as the From alias in the modal's
   *  "Sending as" dropdown. Used by Past Due's Below-$3.5K flow to
   *  default to the settings-configured bulk alias. Falls through to
   *  the chosen template's send_as_email when unset. */
  defaultFromAlias?: string;
  /** Forwarded to buildBulkDrafts so the caller can supply per-row
   *  merge-tag context (e.g. Past Due passes
   *  `{ past_due_month, past_due_reason }` per customer so the
   *  {{MONTH}} and {{REASON}} tags resolve in templates). */
  extraContextFor?: BuildBulkDraftsInput["extraContextFor"];
  /** When set (with `bccBatchTo`), builds BCC batches of N customers
   *  per draft instead of one draft per account. Used by Past Due's
   *  Below $3.5K tab. */
  bccBatchSize?: number;
  /** To: address for BCC-batch drafts — typically `am.bulk_alias_email`. */
  bccBatchTo?: string;
  /** Human-readable label stamped onto each draft's audit-log entry
   *  in the customer's Notes feed. e.g. "Past-due email sent",
   *  "Renewal email sent", "At-risk email sent". Unset → no audit
   *  entry written for this launcher's drafts. */
  auditLabel?: string;
}

export function BulkEmailLauncher({
  customers,
  defaultTemplateId = "general-checkin",
  disabled = false,
  label = "✉️ Email selected",
  ccLookup,
  bccLookup,
  trackingIdFor,
  onDraftCreated,
  defaultFromAlias,
  extraContextFor,
  bccBatchSize,
  bccBatchTo,
  auditLabel,
}: Props) {
  const viewerEmail = useViewerEmail();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<StoredTemplate[]>([]);
  const [ladder, setLadder] = useState<EnterpriseTier[]>([]);
  const [templateId, setTemplateId] = useState<string>("");
  const [drafts, setDrafts] = useState<BulkDraft[]>([]);

  // Fetch templates + ladder lazily — first launch only, then cache
  // for the lifetime of the panel.
  const [resolved, setResolved] = useState(false);
  useEffect(() => {
    if (!open || resolved) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      fetch("/api/templates").then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as StoredTemplate[];
      }),
      getTierLadder().catch(() => [] as EnterpriseTier[]),
    ])
      .then(([allTemplates, fetchedLadder]) => {
        if (cancelled) return;
        const visible = allTemplates.filter((t) =>
          isVisibleToCsm(t, viewerEmail)
        );
        setTemplates(visible);
        setLadder(fetchedLadder);
        // Resolve the initial template id once: requested default, then
        // general-checkin, then whatever's first.
        const tpl =
          visible.find((t) => t.id === defaultTemplateId) ??
          visible.find((t) => t.id === "general-checkin") ??
          visible[0];
        setTemplateId(tpl?.id ?? "");
        setResolved(true);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Unknown error");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, resolved, viewerEmail, defaultTemplateId]);

  // Re-build drafts when the modal is open AND inputs change. Kept as
  // a useMemo on the in-state arrays so swapping templates inside the
  // modal re-renders the bodies instantly.
  const builtDrafts = useMemo<BulkDraft[]>(() => {
    if (!open || !templateId || customers.length === 0) return [];
    const template = templates.find((t) => t.id === templateId);
    if (!template) return [];
    return buildBulkDrafts({
      targets: customers,
      template,
      ladder,
      // No ad-gap pre-fetch in the AM launcher (see comment at top).
      // Templates that reference ad-gap tokens render those as "—".
      adGapByOrg: {},
      ccLookup,
      bccLookup,
      trackingIdFor,
      extraContextFor,
      bccBatchSize,
      bccBatchTo,
      auditLabel,
    });
  }, [open, templateId, customers, templates, ladder, ccLookup, bccLookup, trackingIdFor, extraContextFor, bccBatchSize, bccBatchTo, auditLabel]);

  useEffect(() => {
    setDrafts(builtDrafts);
  }, [builtDrafts]);

  const templateOptions = templates.map((t) => ({ id: t.id, label: t.label }));

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        disabled={disabled || customers.length === 0}
        className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
        title="Draft emails for the selected accounts (Gmail compose + bulk Gmail drafts)"
      >
        {label}
      </button>
      {open ? (
        <BulkDraftsModal
          templates={templateOptions}
          templateId={templateId}
          onTemplateChange={setTemplateId}
          drafts={drafts}
          loading={loading}
          loadingProgress={
            loading
              ? { done: 0, total: customers.length }
              : null
          }
          error={error}
          onClose={() => setOpen(false)}
          onDraftCreated={onDraftCreated}
          defaultFromAlias={defaultFromAlias}
        />
      ) : null}
    </>
  );
}
