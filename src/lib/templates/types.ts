/**
 * Client-safe template types + pure helpers. This module deliberately
 * has zero imports of the KV / file backends, so client components can
 * import { isVisibleToCsm, StoredTemplate } without dragging Node-only
 * modules (postgres, node:fs) into the browser bundle.
 *
 * The server-side IO surface (listTemplates, upsertTemplate, etc.)
 * lives in ./store.ts and re-exports these for back-compat.
 */

export interface StoredTemplate {
  id: string;
  label: string;
  blurb: string;
  /** Free-form descriptive tags (e.g. "renewal", "growth"). UI only. */
  tags: string[];
  /**
   * Lowercased CSM email addresses this template is scoped to. When
   * non-empty, only the listed CSMs see the template in their bulk-draft
   * dropdown / outreach modal. When empty/undefined the template is
   * universal — every CSM sees it. Set via /settings/templates.
   */
  csm_tags?: string[];
  /** Subject line. Plain text. Supports {{merge.tags}}. */
  subject: string;
  /** Body. Rich HTML. Supports {{merge.tags}}. */
  body_html: string;
  created_at: string;
  updated_at: string;
}

/**
 * Returns true if the template is visible to a given viewer. Used by
 * BulkDraftsModal, OutreachModal, RowActions, and the at-risk bulk-
 * compose to scope the template list to the CSM looking at the dashboard.
 */
export function isVisibleToCsm(
  t: Pick<StoredTemplate, "csm_tags">,
  viewerEmail: string | null | undefined
): boolean {
  if (!t.csm_tags || t.csm_tags.length === 0) return true; // universal
  if (!viewerEmail) return true; // pre-session render — don't hide
  return t.csm_tags.includes(viewerEmail.toLowerCase());
}
