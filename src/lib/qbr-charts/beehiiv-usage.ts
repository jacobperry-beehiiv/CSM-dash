import { DB, runNativeQuery } from "../metabase";

/**
 * beehiiv Usage — per-workspace Y/N feature-adoption checklist for
 * the QBR tab. One consolidated Postgres round-trip that runs an
 * EXISTS check per feature against the workspace's publications.
 *
 * Scoring: `active / total` × 100, rounded to the nearest whole
 * percent. Matches the Y/N shape of the CS team's manual QBR
 * checklist so an exported PNG drops straight into a slide.
 *
 * All checks scope through `publications.organization_id = <workspace_id>`.
 * A workspace with zero publications comes back with every feature
 * false (score 0%). Publication-scoped narrowing is a follow-up —
 * for v1 the CSM wants a workspace-wide picture.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UsageFeature {
  key: string;
  label: string;
  active: boolean;
}

export interface BeehiivUsageReport {
  workspace_id: string;
  features: UsageFeature[];
  active: number;
  total: number;
  /** Whole percent (rounded), 0-100. Derived so the client doesn't
   *  have to keep the formula in sync. */
  score: number;
  /** Primary publication for header rendering. When the caller
   *  passes a `publication_id`, that publication wins; otherwise
   *  we pick the workspace's earliest-created publication with a
   *  non-null logo (typically the flagship). Null when no
   *  publication in the workspace has a logo set. */
  publication: {
    publication_id: string;
    publication_name: string | null;
    /** Bare filename as stored on `publications.logo`. Full URL
     *  is constructed client-side via /api/qbr-charts/logo — we
     *  proxy to sidestep the beehiiv CDN's missing CORS headers
     *  so html-to-image can inline the image in exported PNGs. */
    logo_filename: string;
  } | null;
  fetched_at: string;
}

/** Declared feature order matches the CSM's manual QBR checklist —
 *  export renders in this exact order. Labels drive both the API
 *  response and the on-screen table. */
const FEATURES: ReadonlyArray<{ key: keyof UsageRow; label: string }> = [
  { key: "settings_complete", label: "Settings Complete" },
  { key: "welcome_email", label: "Welcome Email" },
  { key: "ab_testing", label: "A/B Testing" },
  { key: "subscriber_tags", label: "Subscriber Tags" },
  { key: "segments", label: "Segments" },
  { key: "automations", label: "Automations" },
  { key: "polls", label: "Polls" },
  { key: "survey_forms", label: "Survey Forms" },
  { key: "referral_program", label: "Referral Program" },
  { key: "recommendations", label: "Recommendations" },
  { key: "ad_network", label: "Ad Network" },
  { key: "slack_community", label: "Slack Community" },
];

type UsageRow = {
  settings_complete: boolean;
  welcome_email: boolean;
  ab_testing: boolean;
  subscriber_tags: boolean;
  segments: boolean;
  automations: boolean;
  polls: boolean;
  survey_forms: boolean;
  referral_program: boolean;
  recommendations: boolean;
  ad_network: boolean;
  slack_community: boolean;
};

export async function computeBeehiivUsage(
  workspaceId: string,
  publicationId?: string | null
): Promise<BeehiivUsageReport> {
  if (!UUID_RE.test(workspaceId)) {
    throw new Error("workspace_id must be a UUID");
  }
  const pubIdFilter =
    publicationId && UUID_RE.test(publicationId) ? publicationId : null;
  const sql = `
    WITH pubs AS (
      SELECT id FROM publications WHERE organization_id = '${workspaceId}'::uuid
    )
    SELECT
      EXISTS (
        SELECT 1 FROM publications
        WHERE organization_id = '${workspaceId}'::uuid
          AND completed_extended_onboarding_at IS NOT NULL
      ) AS settings_complete,
      EXISTS (
        SELECT 1 FROM automation_triggers t
        JOIN automations a ON a.id = t.automation_id
        WHERE a.publication_id IN (SELECT id FROM pubs)
          AND t.event IN ('signup','email_submission')
          AND t.deleted_at IS NULL
          AND a.deleted_at IS NULL
      ) AS welcome_email,
      EXISTS (
        SELECT 1 FROM split_tests st
        JOIN posts p ON p.id = st.post_id
        WHERE p.publication_id IN (SELECT id FROM pubs)
          AND st.deleted_at IS NULL
      ) AS ab_testing,
      EXISTS (
        SELECT 1 FROM publication_subscriber_tags
        WHERE publication_id IN (SELECT id FROM pubs)
      ) AS subscriber_tags,
      EXISTS (
        SELECT 1 FROM segments
        WHERE publication_id IN (SELECT id FROM pubs)
      ) AS segments,
      EXISTS (
        SELECT 1 FROM automations
        WHERE publication_id IN (SELECT id FROM pubs)
          AND deleted_at IS NULL
      ) AS automations,
      EXISTS (
        SELECT 1 FROM polls
        WHERE publication_id IN (SELECT id FROM pubs)
      ) AS polls,
      EXISTS (
        SELECT 1 FROM forms
        WHERE publication_id IN (SELECT id FROM pubs)
      ) AS survey_forms,
      EXISTS (
        SELECT 1 FROM referral_programs
        WHERE publication_id IN (SELECT id FROM pubs)
      ) AS referral_program,
      EXISTS (
        SELECT 1 FROM recommendations
        WHERE publication_id IN (SELECT id FROM pubs)
           OR recommended_publication_id IN (SELECT id FROM pubs)
      ) AS recommendations,
      EXISTS (
        SELECT 1 FROM boost_agreements
        WHERE publication_id IN (SELECT id FROM pubs)
      ) AS ad_network,
      EXISTS (
        SELECT 1 FROM community_members
        WHERE publication_id IN (SELECT id FROM pubs)
      ) AS slack_community
  `;
  // Primary publication pick — either the caller's explicit
  // publication_id (from the QBR tab's PublicationPicker) or the
  // workspace's earliest-created publication with a non-null logo.
  // Runs in parallel with the usage EXISTS query so the round-trip
  // count stays at 2 regardless of scoping.
  const pubSql = pubIdFilter
    ? `SELECT id::text AS publication_id, name AS publication_name, logo AS logo_filename
         FROM publications
        WHERE id = '${pubIdFilter}'::uuid
          AND organization_id = '${workspaceId}'::uuid
        LIMIT 1`
    : `SELECT id::text AS publication_id, name AS publication_name, logo AS logo_filename
         FROM publications
        WHERE organization_id = '${workspaceId}'::uuid
          AND logo IS NOT NULL
          AND logo <> ''
        ORDER BY created_at ASC
        LIMIT 1`;
  const [rows, pubRows] = await Promise.all([
    runNativeQuery(DB.POSTGRES, sql) as Promise<UsageRow[]>,
    runNativeQuery(DB.POSTGRES, pubSql) as Promise<
      Array<{
        publication_id: string;
        publication_name: string | null;
        logo_filename: string | null;
      }>
    >,
  ]);
  const row = rows[0] ?? {
    settings_complete: false,
    welcome_email: false,
    ab_testing: false,
    subscriber_tags: false,
    segments: false,
    automations: false,
    polls: false,
    survey_forms: false,
    referral_program: false,
    recommendations: false,
    ad_network: false,
    slack_community: false,
  };
  const features: UsageFeature[] = FEATURES.map((f) => ({
    key: f.key,
    label: f.label,
    active: Boolean(row[f.key]),
  }));
  const active = features.filter((f) => f.active).length;
  const total = features.length;
  const score = total === 0 ? 0 : Math.round((active / total) * 100);
  const pubRow = pubRows[0];
  const publication =
    pubRow && pubRow.logo_filename
      ? {
          publication_id: pubRow.publication_id,
          publication_name: pubRow.publication_name,
          logo_filename: pubRow.logo_filename,
        }
      : null;
  return {
    workspace_id: workspaceId,
    features,
    active,
    total,
    score,
    publication,
    fetched_at: new Date().toISOString(),
  };
}
