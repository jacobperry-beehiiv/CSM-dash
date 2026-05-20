import { applyMergeTags } from "./merge-tags";
import {
  composeUrlForTemplate,
  composeUrlWithAdGap,
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
  const { targets, template: tpl, ladder, adGapByOrg } = input;
  const usesAdGap =
    /customer\.(ad_revenue_actual|ad_revenue_potential|ad_revenue_gap|ad_zero_pubs)/.test(
      tpl.subject + tpl.body_html
    );

  const drafts: BulkDraft[] = [];
  for (const c of targets) {
    if (!c.owner_email) continue;
    const adGap =
      usesAdGap && c.workspace_id ? adGapByOrg?.[c.workspace_id] ?? null : null;
    const composeUrl =
      usesAdGap && adGap
        ? composeUrlWithAdGap(tpl, c, ladder, adGap)
        : composeUrlForTemplate(tpl, c, ladder);
    if (!composeUrl) continue;
    const ctx = { ladder, adGap };
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

    drafts.push({
      customer_label: c.company_name ?? c.workspace_name ?? ownerEmail,
      to: ownerEmail,
      subject,
      body_text,
      body_html,
      compose_url: composeUrl,
      recipients,
    });
  }
  return drafts;
}
