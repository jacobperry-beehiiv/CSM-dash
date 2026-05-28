/**
 * External-link helpers — masquerade into a customer workspace and pre-compose
 * an email in Gmail.
 */

import type { AdGapReport, Customer } from "./types";
import { applyMergeTags } from "./templates/merge-tags";
import type { StoredTemplate } from "./templates/store";
import type { EnterpriseTier } from "./tiers/store";

const DEFAULT_MASQUERADE_TEMPLATE =
  "https://app.beehiiv.com/system_admin/users/masquerade?email={email}";

const DEFAULT_METABASE_PUB_TEMPLATE =
  "https://beehiiv.metabaseapp.com/question/3401-all-with-filters?company_%252F_workspace_search={workspace_name}";

/**
 * Masquerade URL keyed on email (per beehiiv system_admin route).
 */
export function masqueradeUrl(email: string | null | undefined): string | null {
  if (!email) return null;
  const tpl =
    process.env.NEXT_PUBLIC_MASQUERADE_URL_TEMPLATE ??
    DEFAULT_MASQUERADE_TEMPLATE;
  return tpl.replace("{email}", encodeURIComponent(email));
}

/**
 * HubSpot company-page URL. Returns null when we don't have the
 * `hubspot_company_id` (e.g. the row didn't match during sync-time
 * enrichment). Portal id is the beehiiv workspace's HubSpot account —
 * overridable via NEXT_PUBLIC_HUBSPOT_PORTAL_ID if we ever stand up
 * a second portal.
 *
 * `0-2` in the path is HubSpot's object-type id for companies (vs
 * 0-1 contacts, 0-3 deals).
 */
const DEFAULT_HUBSPOT_PORTAL_ID = "21568530";

export function hubspotCompanyUrl(
  hubspotCompanyId: string | null | undefined
): string | null {
  if (!hubspotCompanyId) return null;
  const portal =
    process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID ?? DEFAULT_HUBSPOT_PORTAL_ID;
  return `https://app.hubspot.com/contacts/${portal}/record/0-2/${encodeURIComponent(
    hubspotCompanyId
  )}`;
}

/**
 * Stripe Dashboard URL for a customer record. Defaults to live mode
 * since this dashboard reads production data; set
 * NEXT_PUBLIC_STRIPE_TEST_MODE=true to point links at the test
 * dashboard for local sandboxing.
 */
export function stripeCustomerUrl(
  stripeCustomerId: string | null | undefined
): string | null {
  if (!stripeCustomerId) return null;
  const test = process.env.NEXT_PUBLIC_STRIPE_TEST_MODE === "true";
  const segment = test ? "test/customers" : "customers";
  return `https://dashboard.stripe.com/${segment}/${encodeURIComponent(
    stripeCustomerId
  )}`;
}

/**
 * Slack deep-link for a channel ID. Returns the archives URL which
 * works in both the web client and the native app (Slack redirects to
 * the app via custom URL scheme when installed). Workspace subdomain
 * defaults to "beehiiv" — override via NEXT_PUBLIC_SLACK_WORKSPACE if
 * the project is ever pointed at a different org.
 */
const DEFAULT_SLACK_WORKSPACE = "beehiiv";

export function slackChannelUrl(
  channelId: string | null | undefined
): string | null {
  if (!channelId) return null;
  const trimmed = channelId.trim();
  // Sanity-check the shape — Slack IDs are uppercase alphanumerics
  // starting with C (public channel), G (private group), or D (DM).
  if (!/^[CGD][A-Z0-9]{6,}$/.test(trimmed)) return null;
  const workspace =
    process.env.NEXT_PUBLIC_SLACK_WORKSPACE ?? DEFAULT_SLACK_WORKSPACE;
  return `https://${workspace}.slack.com/archives/${trimmed}`;
}

/**
 * Returns a Metabase deep link for a specific publication / workspace.
 * Configurable via NEXT_PUBLIC_METABASE_PUB_URL_TEMPLATE — substitution
 * tokens supported: {workspace_id}, {workspace_name}, {publication_id}.
 */
export function metabasePubUrl(args: {
  workspace_id?: string | null;
  workspace_name?: string | null;
  publication_id?: string | null;
}): string | null {
  const tpl =
    process.env.NEXT_PUBLIC_METABASE_PUB_URL_TEMPLATE ??
    DEFAULT_METABASE_PUB_TEMPLATE;
  const ws = args.workspace_id ?? "";
  const wn = args.workspace_name ?? "";
  const pub = args.publication_id ?? "";
  if (!ws && !wn && !pub) return null;
  return tpl
    .replace("{workspace_id}", encodeURIComponent(ws))
    .replace("{workspace_name}", encodeURIComponent(wn))
    .replace("{publication_id}", encodeURIComponent(pub));
}

interface ComposeArgs {
  to: string;
  /** Comma-separated CC list. Optional. */
  cc?: string;
  /** Comma-separated BCC list. Optional. */
  bcc?: string;
  subject: string;
  body: string;
}

export function gmailComposeUrl({
  to,
  cc,
  bcc,
  subject,
  body,
}: ComposeArgs): string {
  const params = new URLSearchParams({
    view: "cm",
    fs: "1",
    to,
    su: subject,
    body,
  });
  if (cc && cc.trim()) params.set("cc", cc.trim());
  if (bcc && bcc.trim()) params.set("bcc", bcc.trim());
  return `https://mail.google.com/mail/?${params.toString()}`;
}

function htmlToText(html: string): string {
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

/**
 * Build a Gmail compose URL for a customer + a chosen template, applying
 * merge tags. Used by the row-level "Email" quick button after fetching
 * templates from /api/templates client-side.
 */
export function composeUrlForTemplate(
  template: StoredTemplate,
  customer: Customer,
  ladder?: EnterpriseTier[],
  extra?: { cc?: string | null; bcc?: string | null }
): string | null {
  const to = customer.owner_email ?? null;
  if (!to) return null;
  const ctx = { ladder };
  const subject = applyMergeTags(template.subject, customer, ctx);
  const body = htmlToText(applyMergeTags(template.body_html, customer, ctx));
  return gmailComposeUrl({
    to,
    cc: extra?.cc ?? undefined,
    bcc: extra?.bcc ?? undefined,
    subject,
    body,
  });
}

/**
 * Variant that also threads an ad-gap report into the merge context so
 * `{{customer.ad_revenue_*}}` tokens resolve. Used by the utilization tab's
 * bulk-draft flow when the ad-revenue template is in play.
 */
export function composeUrlWithAdGap(
  template: StoredTemplate,
  customer: Customer,
  ladder: EnterpriseTier[] | undefined,
  adGap: AdGapReport | null,
  extra?: { cc?: string | null; bcc?: string | null }
): string | null {
  const to = customer.owner_email ?? null;
  if (!to) return null;
  const ctx = { ladder, adGap };
  const subject = applyMergeTags(template.subject, customer, ctx);
  const body = htmlToText(applyMergeTags(template.body_html, customer, ctx));
  return gmailComposeUrl({
    to,
    cc: extra?.cc ?? undefined,
    bcc: extra?.bcc ?? undefined,
    subject,
    body,
  });
}
