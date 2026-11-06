"use client";

import type { Customer } from "@/lib/types";
import {
  hubspotCompanyUrl,
  masqueradeUrl,
  metabasePubUrl,
  stripeCustomerUrl,
  systemAdminWorkspaceUrl,
  zendeskSearchUrl,
} from "@/lib/links";
import { MAPPABLE_DASHBOARD_FIELDS } from "@/lib/data/field-mappings-types";
import { CopyButton } from "./copy-button";
import { HubSpotLinkBadge } from "./hubspot-link-badge";
import { MappedFieldEditor } from "./mapped-field-editor";

/**
 * Header block for one customer: a row of quick-jump links over a row
 * of copyable identifiers.
 *
 * ─── Why this is a component and not inline JSX ───────────────────
 * All of this used to live inline inside CustomerDetailPanel, which
 * meant the standalone /account/[id] page had none of it — no
 * masquerade, no Stripe, not even the workspace ID you paste into
 * Metabase. That page is the one Slack deep-links into (see
 * slack-views.ts) and the one a CSM opens before a renewal call, so
 * it was the surface that could least afford to be the thin one. The
 * two drifted precisely because the markup lived in only one of
 * them; rendering the same component in both is what stops it
 * happening again.
 *
 * ─── Why some links appear twice ──────────────────────────────────
 * Stripe and the system-admin page are both a pill up top AND the
 * href on their ID badge below. They answer different questions —
 * the pill is "take me there", the badge is "give me the string" —
 * and collapsing them would cost one of the two. The badge hrefs
 * predate the pills and people have the muscle memory.
 *
 * Every link self-hides when the ID behind it is missing, so a
 * customer with no Stripe record (trial, migrated off) renders a
 * shorter strip rather than a link that 404s — the same posture the
 * helpers in lib/links.ts take.
 *
 * ─── "use client" is load-bearing ─────────────────────────────────
 * MappedFieldEditor (the Drive-folder pill) takes a `renderReadOnly`
 * *function* prop, and a server component can't pass a function
 * across the client boundary. /account/[id] is a server component,
 * so this wrapper has to own the boundary itself rather than letting
 * its caller decide.
 */

interface Props {
  customer: Customer;
}

// ─── Pill chrome ───────────────────────────────────────────────────
// Shared with the Drive-folder affordance below, which was the first
// pill in this strip and set the shape. Keep them visually identical
// apart from colour or the row reads as two different controls.
const PILL =
  "inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full border transition-colors";
const PILL_NEUTRAL =
  "border-border-strong bg-surface text-fg hover:bg-canvas dark:hover:bg-surface-2";

function Pill({
  href,
  title,
  label,
  className = PILL_NEUTRAL,
}: {
  href: string;
  title: string;
  label: string;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={`${PILL} ${className}`}
    >
      {label}
      <span aria-hidden>↗</span>
    </a>
  );
}

export function CustomerIdentifiers({ customer: c }: Props) {
  // ─── Quick links ─────────────────────────────────────────────────
  // Built up front so the row can decide whether it has anything to
  // render at all. Order is the order a CSM reaches for them: get
  // into the product, check what they're paying, check the CRM, then
  // the three investigative tools.
  const masquerade = masqueradeUrl(c.owner_email);
  const stripe = stripeCustomerUrl(c.stripe_customer_id);
  const hubspot = hubspotCompanyUrl(c.hubspot_company_id);
  const systemAdmin = systemAdminWorkspaceUrl(c.workspace_id);
  const zendesk = zendeskSearchUrl(c.owner_email);
  const metabase = metabasePubUrl({
    workspace_id: c.workspace_id,
    workspace_name: c.workspace_name,
  });

  const hasQuickLinks = Boolean(
    masquerade || stripe || hubspot || systemAdmin || zendesk || metabase
  );
  const hasIdentifiers = Boolean(
    c.workspace_id || c.owner_email || c.stripe_customer_id
  );

  if (!hasQuickLinks && !hasIdentifiers) return null;

  return (
    <div className="space-y-2">
      {hasQuickLinks ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {masquerade ? (
            <Pill
              href={masquerade}
              label="Masq"
              title="Masquerade into this workspace in beehiiv"
            />
          ) : null}
          {stripe ? (
            <Pill
              href={stripe}
              label="Stripe"
              title="Open the billing record in Stripe"
            />
          ) : null}
          {hubspot ? (
            /* Same #ff7a59 wordmark colour RowActions uses, so the
             * HubSpot jump looks the same wherever it appears. */
            <Pill
              href={hubspot}
              label="HubSpot"
              title="Open the company record in HubSpot"
              className="border-[#ff7a59]/40 bg-[#ff7a59]/10 text-[#c2410c] hover:bg-[#ff7a59]/20 dark:text-[#ffa88c]"
            />
          ) : null}
          {systemAdmin ? (
            <Pill
              href={systemAdmin}
              label="Admin"
              title="Open the workspace in beehiiv system admin"
            />
          ) : null}
          {zendesk ? (
            <Pill
              href={zendesk}
              label="Zendesk"
              title="Search this customer's Zendesk tickets"
            />
          ) : null}
          {metabase ? (
            <Pill
              href={metabase}
              label="Metabase"
              title="Open this workspace in Metabase"
            />
          ) : null}
          {/* Drive folder shortcut. Auto-populated by @bot assign when
           *  it creates the folder; also editable inline (delegates to
           *  MappedFieldEditor, which pushes to HubSpot's
           *  customer_folder property when the field mapping's
           *  direction is push/both). The read-only renderer keeps the
           *  emerald pill so it reads as a quick link, not a form
           *  field — it sits in this row rather than down with the IDs
           *  because it is one. */}
          <MappedFieldEditor
            fieldDef={
              MAPPABLE_DASHBOARD_FIELDS.find(
                (f) => f.id === "property_customer_folder"
              )!
            }
            currentValue={c.property_customer_folder}
            workspaceId={c.workspace_id}
            renderReadOnly={(value) =>
              value ? (
                <a
                  href={value}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${PILL} border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200 dark:hover:bg-emerald-500/20`}
                  title="Open the customer's shared Drive folder (HubSpot property: Customer Folder)"
                >
                  <span aria-hidden>📁</span>
                  Drive folder
                  <span aria-hidden>↗</span>
                </a>
              ) : (
                <span className="text-[11px] text-subtle italic">
                  No Drive folder linked
                </span>
              )
            }
          />
        </div>
      ) : null}

      {/* ─── Identifiers ──────────────────────────────────────────────
       *  At-a-glance IDs, each click-to-copy. Owner email is surfaced
       *  here (in addition to the Contact section further down) so a
       *  CSM doesn't have to expand a collapsed section just to grab
       *  it — it's almost always the first thing they want. */}
      {hasIdentifiers ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          {c.owner_email ? (
            <span className="flex items-center gap-1.5">
              <span>Owner:</span>
              <CopyButton
                value={c.owner_email}
                label="Copy owner email"
                href={`mailto:${c.owner_email}`}
                hrefLabel="Open in mail client"
              />
            </span>
          ) : null}
          {c.workspace_id ? (
            <>
              {c.owner_email ? <span className="text-subtle">·</span> : null}
              <span>Workspace ID:</span>
              {/* Copy stays the primary action — the ID is what people
               *  paste into Metabase and Linear. The href rides along
               *  as the secondary affordance so the system-admin page
               *  is one click from the card instead of a hand-built
               *  URL. */}
              <CopyButton
                value={c.workspace_id}
                label="Copy workspace ID"
                href={systemAdmin}
                hrefLabel="Open in beehiiv system admin"
              />
            </>
          ) : null}
          {c.stripe_customer_id ? (
            <>
              <span className="text-subtle">·</span>
              <span>Stripe:</span>
              <CopyButton
                value={c.stripe_customer_id}
                label="Copy Stripe customer ID"
                href={stripe}
                hrefLabel="Open in Stripe Dashboard"
              />
            </>
          ) : null}
          {/* HubSpot link badge — confidence indicator for the join
           *  between this row and its HubSpot company record. Set by
           *  scripts/sync.ts based on which resolution path won. Drives
           *  whether the write-side affordances (CSM refresh, post-
           *  note, /update-csm) can find the HubSpot company. */}
          <span className="text-subtle">·</span>
          <HubSpotLinkBadge
            linkSource={c.hubspot_link_source ?? null}
            warning={c.hubspot_link_warning ?? null}
            hubspotCompanyId={c.hubspot_company_id ?? null}
            workspaceId={c.workspace_id ?? null}
            hasStripeId={Boolean(c.stripe_customer_id)}
          />
        </div>
      ) : null}
    </div>
  );
}
