"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Compact confidence indicator for the HubSpot ↔ dashboard join.
 * Lives in the customer detail panel's top metadata strip, next to
 * the Owner / Workspace ID / Stripe ID identifiers.
 *
 * What it shows depends on how sync.ts resolved the link:
 *
 *   stripe_id      → 🔗 HubSpot linked        (green, healthy)
 *   email_fallback → ⚠ Email-fallback link    (amber, degraded)
 *   none           → ⚠ No HubSpot link        (red, blocked)
 *   warning set    → adds an amber drift warning regardless of source
 *
 * When the link is missing or weak, the badge becomes a button that
 * POSTs to /api/hubspot/resolve-by-stripe — manually re-runs the
 * Stripe-ID lookup against HubSpot and writes the resolved company
 * ID into the customer-overrides KV so the detail panel + every
 * write path (refresh-csm, post-note, /update-csm) unblocks
 * immediately. The button is hidden when there's no Stripe ID on
 * file (nothing to resolve from) or when the link is already
 * healthy.
 */
interface Props {
  linkSource: "stripe_id" | "email_fallback" | "none" | null;
  warning: string | null;
  hubspotCompanyId: string | null;
  workspaceId: string | null;
  hasStripeId: boolean;
}

export function HubSpotLinkBadge({
  linkSource,
  warning,
  hubspotCompanyId,
  workspaceId,
  hasStripeId,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<string | null>(null);

  const handleReresolve = async () => {
    if (!workspaceId) return;
    setBusy(true);
    setReport(null);
    try {
      const r = await fetch("/api/hubspot/resolve-by-stripe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId }),
      });
      const json = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        hubspot_company_id?: string;
        hubspot_company_name?: string;
      };
      if (!r.ok || !json.ok) {
        throw new Error(json.error ?? `HTTP ${r.status}`);
      }
      setReport(
        `Linked to ${
          json.hubspot_company_name ?? "HubSpot company"
        } (${json.hubspot_company_id ?? "—"})`
      );
      // Re-fetch server data so the badge re-renders with the new
      // hubspot_link_source + hubspot_company_id from the override.
      router.refresh();
    } catch (e) {
      setReport(
        `Re-resolve failed: ${e instanceof Error ? e.message : "unknown"}`
      );
    } finally {
      setBusy(false);
      // Toast clears on its own — don't leave the user staring at a
      // stale message after they've moved on.
      window.setTimeout(() => setReport(null), 8000);
    }
  };

  const source = linkSource ?? "none";
  const canReresolve = hasStripeId && workspaceId && source !== "stripe_id";

  let pillClass = "";
  let label = "";
  let tooltip = "";
  switch (source) {
    case "stripe_id":
      pillClass =
        "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200";
      label = "🔗 HubSpot linked";
      tooltip = `Resolved via stripe_customer_id property — company ${
        hubspotCompanyId ?? "—"
      }. Healthy join: writes to HubSpot will land on the right record.`;
      break;
    case "email_fallback":
      pillClass =
        "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200";
      label = "⚠ Email-fallback link";
      tooltip = `Stripe-ID lookup missed; resolved by owner_email → primary company instead. Add the Stripe ID to the HubSpot company record to upgrade this link to the primary source.`;
      break;
    default:
      pillClass =
        "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200";
      label = "⚠ No HubSpot link";
      tooltip = hasStripeId
        ? `No HubSpot company has stripe_customer_id = ${"(this row's Stripe ID)"}. Add it to the HubSpot company, then click Re-resolve.`
        : "No Stripe customer ID on file — can't auto-resolve the HubSpot company. Set the Stripe ID in Metabase first.";
      break;
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${pillClass}`}
        title={tooltip}
      >
        {label}
      </span>
      {warning ? (
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200"
          title={warning}
        >
          ⚠ Link mismatch
        </span>
      ) : null}
      {canReresolve ? (
        <button
          type="button"
          onClick={handleReresolve}
          disabled={busy}
          className="text-[11px] text-accent hover:underline disabled:opacity-50"
          title="Look up this row's HubSpot company via the Stripe customer ID and pin the result. Fixes a stale or missing link without waiting for the next nightly sync."
        >
          {busy ? "Re-resolving…" : "🔄 Re-resolve via Stripe ID"}
        </button>
      ) : null}
      {report ? (
        <span
          className="text-[11px] text-muted italic max-w-[280px] truncate"
          title={report}
        >
          {report}
        </span>
      ) : null}
    </span>
  );
}
