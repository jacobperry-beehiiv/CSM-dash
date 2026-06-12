import { applyMergeTags, type MergeContext } from "./merge-tags";
import {
  composeUrlForTemplate,
  composeUrlWithAdGap,
  gmailComposeUrl,
} from "../links";
import type { AdGapReport, Customer } from "../types";
import type { EnterpriseTier } from "../tiers/store";
import type { StoredTemplate } from "./types";
import type { BulkDraft } from "@/components/bulk-drafts-modal";

/**
 * Bulk-draft assembly extracted from customer-table.tsx so the AM
 * dashboard's per-tab "Email selected" launchers (Past Due,
 * Approaching Enterprise) can share the same merge-tag, body, and
 * recipient-list logic without duplicating ~80 lines.
 *
 * Pure functions only — no React state, no fetches. Callers are
 * responsible for fetching templates + ladder + ad-gap reports.
 */

/** Convert the rich-HTML body templates store as into a Slack/email-
 *  paste-friendly plain-text string. Same transforms used in the
 *  original customer-table builder so output stays identical across
 *  callers. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\/(p|li|div|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>(?!\n)/gi, "\n")
    .replace(/<li[^>]*>/gi, "  • ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface BuildBulkDraftsInput {
  targets: Customer[];
  template: StoredTemplate;
  /** Pass [] to render `{{customer.tier_*}}` tokens as "—". */
  ladder?: EnterpriseTier[];
  /** Optional per-workspace ad-gap reports — only matters when the
   *  template's body references `customer.ad_revenue_*` tokens. */
  adGapByOrg?: Record<string, AdGapReport | null>;
  /** Optional per-customer CC resolver. Used by the AM Past Due
   *  Enterprise flow to CC the assigned CSM on every draft. Return
   *  null when the customer has no CC; the returned string is a
   *  comma-separated list (so multiple CCs per customer are fine). */
  ccLookup?: (c: Customer) => string | null;
  /** Optional per-customer BCC resolver. Same semantics as ccLookup. */
  bccLookup?: (c: Customer) => string | null;
  /** Returns the opaque tracking_id used by the bulk-drafts modal's
   *  `onDraftCreated` callback to report back which source customers
   *  got actioned. Past Due wires to stripe_customer_id, Proactive
   *  Outreach to workspace_id. Unset → no lifecycle tracking. */
  trackingIdFor?: (c: Customer) => string | null;
  /** Optional per-customer extra merge-tag context. Lets callers
   *  thread row-specific values into the renderer without polluting
   *  the Customer type. Today: Past Due passes
   *  `{ past_due_month, past_due_reason }` so {{MONTH}} / {{REASON}}
   *  tags resolve. The returned object is merged into the per-row
   *  MergeContext alongside ladder + adGap. Missing entries fall
   *  through to ctx defaults (which themselves fall through to "—"). */
  extraContextFor?: (c: Customer) => Partial<MergeContext>;
  /** When set, group customers into BCC batches instead of one draft
   *  per customer. Each batch becomes one draft with `to` =
   *  `bccBatchTo` and owner emails in BCC (Below $3.5K past-due). */
  bccBatchSize?: number;
  /** To: address for BCC-batch drafts — typically the configured
   *  bulk outreach alias. May be empty; Gmail compose still works with
   *  BCC-only. */
  bccBatchTo?: string;
}

/**
 * Render N drafts from N customer rows + one template. The customer-
 * table flow and the AM "Email selected" flow both call into this.
 *
 * Each returned draft carries:
 *   • subject + body_html + body_text (merge tags applied)
 *   • compose_url for the Gmail web-compose deep link
 *   • recipients[]: owner_email (default-checked) + any HubSpot
 *     contacts whose primary associated company is this customer's
 *     (so the bulk-drafts modal can let the CSM toggle per row)
 *
 * Rows without an owner_email are skipped (you can't compose an
 * email to nobody). Same for rows where the compose URL build
 * fails (e.g. missing fields the link helper needs).
 */
export function buildBulkDrafts(input: BuildBulkDraftsInput): BulkDraft[] {
  const {
    targets,
    template: tpl,
    ladder,
    adGapByOrg,
    ccLookup,
    bccLookup,
    trackingIdFor,
    extraContextFor,
    bccBatchSize,
    bccBatchTo,
  } = input;

  if (bccBatchSize && bccBatchSize > 0) {
    return buildBccBatchDrafts({
      targets,
      template: tpl,
      ladder,
      adGapByOrg,
      trackingIdFor,
      extraContextFor,
      batchSize: bccBatchSize,
      toEmail: (bccBatchTo ?? "").trim(),
    });
  }
  const usesAdGap =
    /customer\.(ad_revenue_actual|ad_revenue_potential|ad_revenue_gap|ad_zero_pubs)/.test(
      tpl.subject + tpl.body_html
    );

  const drafts: BulkDraft[] = [];
  for (const c of targets) {
    if (!c.owner_email) continue;
    const adGap =
      usesAdGap && c.workspace_id ? adGapByOrg?.[c.workspace_id] ?? null : null;
    const cc = ccLookup?.(c) ?? null;
    const bcc = bccLookup?.(c) ?? null;
    const composeUrl =
      usesAdGap && adGap
        ? composeUrlWithAdGap(tpl, c, ladder, adGap, { cc, bcc })
        : composeUrlForTemplate(tpl, c, ladder, { cc, bcc });
    if (!composeUrl) continue;
    // Merge per-row extra context (e.g. Past Due passes
    // past_due_month / past_due_reason) into the base ctx so MONTH /
    // REASON tags resolve. Caller-supplied values win — ladder +
    // adGap are computed locally and shouldn't be overridden, but
    // the row-specific entries can supply anything else.
    const extras: Partial<MergeContext> = extraContextFor?.(c) ?? {};
    const ctx: MergeContext = { ladder, adGap, ...extras };
    const subject = applyMergeTags(tpl.subject, c, ctx);
    const body_html = applyMergeTags(tpl.body_html, c, ctx);
    const body_text = htmlToText(body_html);

    // Owner gets the default check; every HubSpot contact whose
    // primary associated company is this customer becomes an
    // available recipient. Dedupe by lowercased email.
    const ownerEmail = c.owner_email;
    const seen = new Set<string>([ownerEmail.toLowerCase()]);
    const recipients: BulkDraft["recipients"] = [
      {
        email: ownerEmail,
        name: c.property_main_contact ?? null,
        default: true,
      },
    ];
    for (const contact of c.hubspot_contacts ?? []) {
      if (!contact.email) continue;
      const key = contact.email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      recipients.push({
        email: contact.email,
        name: contact.name,
        default: false,
      });
    }

    // Closure for live re-rendering when the modal user swaps the
    // selected recipient. Captures customer + template + ctx so the
    // modal doesn't need to know about merge-tag plumbing.
    const rerender = (rctx: {
      recipient_email: string | null;
      recipient_count: number;
    }) => {
      const liveCtx = {
        ...ctx,
        recipient_email: rctx.recipient_email,
        recipient_count: rctx.recipient_count,
      };
      const liveSubject = applyMergeTags(tpl.subject, c, liveCtx);
      const liveHtml = applyMergeTags(tpl.body_html, c, liveCtx);
      return {
        subject: liveSubject,
        body_html: liveHtml,
        body_text: htmlToText(liveHtml),
      };
    };

    drafts.push({
      customer_label: c.company_name ?? c.workspace_name ?? ownerEmail,
      tracking_id: trackingIdFor?.(c) ?? undefined,
      to: ownerEmail,
      cc: cc ?? undefined,
      bcc: bcc ?? undefined,
      // Template-level default sender. When set, the Gmail API draft
      // path uses it as the From header; the compose-URL path embeds
      // it as authuser so the right Google account opens.
      from: tpl.send_as_email || undefined,
      subject,
      body_text,
      body_html,
      compose_url: composeUrl,
      recipients,
      rerender,
    });
  }
  return drafts;
}

/** Below-$3.5K past-due flow — one draft per batch of N customers,
 *  recipients in BCC so they never see each other. Merge tags render
 *  against the first customer in each batch (templates should be
 *  generic). */
function buildBccBatchDrafts(args: {
  targets: Customer[];
  template: StoredTemplate;
  ladder?: EnterpriseTier[];
  adGapByOrg?: Record<string, AdGapReport | null>;
  trackingIdFor?: (c: Customer) => string | null;
  extraContextFor?: (c: Customer) => Partial<MergeContext>;
  batchSize: number;
  toEmail: string;
}): BulkDraft[] {
  const {
    targets,
    template: tpl,
    ladder,
    adGapByOrg,
    trackingIdFor,
    extraContextFor,
    batchSize,
    toEmail,
  } = args;

  const eligible = targets.filter((c) => Boolean(c.owner_email));
  const batches: Customer[][] = [];
  for (let i = 0; i < eligible.length; i += batchSize) {
    batches.push(eligible.slice(i, i + batchSize));
  }

  const usesAdGap =
    /customer\.(ad_revenue_actual|ad_revenue_potential|ad_revenue_gap|ad_zero_pubs)/.test(
      tpl.subject + tpl.body_html
    );

  const drafts: BulkDraft[] = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const anchor = batch[0];
    if (!anchor?.owner_email) continue;

    const adGap =
      usesAdGap && anchor.workspace_id
        ? adGapByOrg?.[anchor.workspace_id] ?? null
        : null;
    const extras: Partial<MergeContext> = extraContextFor?.(anchor) ?? {};
    const ctx: MergeContext = { ladder, adGap, ...extras };
    const subject = applyMergeTags(tpl.subject, anchor, ctx);
    const body_html = applyMergeTags(tpl.body_html, anchor, ctx);
    const body_text = htmlToText(body_html);

    const bcc = batch
      .map((c) => c.owner_email)
      .filter((e): e is string => Boolean(e))
      .join(", ");

    const tracking_ids = batch
      .map((c) => trackingIdFor?.(c) ?? null)
      .filter((id): id is string => Boolean(id));

    const compose_url = gmailComposeUrl({
      to: toEmail,
      bcc,
      subject,
      body: body_text,
      authuser: tpl.send_as_email || undefined,
    });

    drafts.push({
      customer_label: `Batch ${i + 1} of ${batches.length} — ${batch.length} recipient${
        batch.length === 1 ? "" : "s"
      }`,
      tracking_ids,
      to: toEmail,
      bcc,
      from: tpl.send_as_email || undefined,
      subject,
      body_text,
      body_html,
      compose_url,
      bcc_batch: true,
      recipients: batch.map((c) => ({
        email: c.owner_email as string,
        name: c.property_main_contact ?? c.company_name ?? null,
        default: true,
      })),
    });
  }

  return drafts;
}
