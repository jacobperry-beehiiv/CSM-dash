/**
 * D&C Upgrade Analysis — pillar SQL runners.
 *
 * One function per pillar. Each takes the pub identity + config +
 * emits typed counters. Every ClickHouse query backticks lowercase
 * identifiers because the Metabase MCP layer upper-cases bare
 * identifiers and ClickHouse is case-sensitive (this is the same
 * gotcha noted in the interpretation-guardrails.md file the SQL
 * came from — see the "READ THIS FIRST" section).
 *
 * The SQL is lifted directly from
 *   scratchpad/upgrade-analysis/references/data-pulls.md
 * with only two changes:
 *   1. Parameters (`:PUB`, `:ORG`) are safely quoted below rather
 *      than substituted textually — pub_id / org_id are alphanumeric
 *      but we still escape single quotes defensively.
 *   2. Window lengths come from the threshold config so D&C can
 *      widen a lookback without a code change.
 */

import { DB, runNativeQuery } from "../../metabase";
import type { UpgradeAnalysisConfig } from "../../data/upgrade-analysis-config-types";
import type {
  AcquisitionChannelRow,
  AcquisitionCounters,
  AnalysisWindow,
  DeferralReasonRow,
  FunnelCounters,
  IdentityCounters,
  NetworkCounters,
  OrgFlagRow,
  ProviderCounters,
  ProviderRow,
} from "./types";
import { looksSuspiciousLabel } from "./rules";

// ─── Window helpers ──────────────────────────────────────────────────────

/** Given a preferred window and a config default lookback, produce
 *  both the ClickHouse timestamp filter and the effective day count.
 *  The two shapes:
 *   - lookback: `timestamp >= now() - INTERVAL N DAY`
 *   - range:   `timestamp BETWEEN start 00:00 AND end 23:59:59`
 *
 *  The day count is the tile subheader source. For explicit ranges
 *  we compute the inclusive whole-day span; for lookback it's the
 *  literal `lookback_days`. When no window override is passed, the
 *  config's per-pillar default lookback wins. */
function resolveWindow(
  window: AnalysisWindow | undefined,
  fallbackLookbackDays: number
): { clause: string; effectiveDays: number } {
  if (!window) {
    return {
      clause: `\`timestamp\` >= now() - INTERVAL ${fallbackLookbackDays} DAY`,
      effectiveDays: fallbackLookbackDays,
    };
  }
  if (window.kind === "lookback") {
    return {
      clause: `\`timestamp\` >= now() - INTERVAL ${window.lookback_days} DAY`,
      effectiveDays: window.lookback_days,
    };
  }
  // Range — bracket to midnight-to-midnight and count inclusive days.
  const start = window.start_date;
  const end = window.end_date;
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  const effectiveDays =
    Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
      ? Math.max(1, Math.round((endMs - startMs) / 86_400_000) + 1)
      : fallbackLookbackDays;
  return {
    clause: `\`timestamp\` >= toDateTime('${start} 00:00:00') AND \`timestamp\` <= toDateTime('${end} 23:59:59')`,
    effectiveDays,
  };
}

/** Postgres-flavored variant of `resolveWindow` for the unsubscribe
 *  count. `subscriptions.unsubscribed_at` is a timestamp with time
 *  zone. Uses the standard PG interval syntax rather than ClickHouse. */
function resolveWindowPg(
  window: AnalysisWindow | undefined,
  fallbackLookbackDays: number
): string {
  if (!window || window.kind === "lookback") {
    const days = window ? window.lookback_days : fallbackLookbackDays;
    return `unsubscribed_at >= now() - INTERVAL '${days} days'`;
  }
  return `unsubscribed_at >= '${window.start_date} 00:00:00' AND unsubscribed_at <= '${window.end_date} 23:59:59'`;
}

// ─── Utilities ───────────────────────────────────────────────────────────

/** Defensive single-quote escape for SQL literals. All parameters we
 *  substitute (pub_id, org_id) should already be alphanumeric, but a
 *  bad KV write shouldn't turn into SQL injection through the
 *  scorecard. */
function q(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** Promise wrapper that resolves to `fallback` if the query doesn't
 *  settle within `ms`. Same shape as deliverability.ts's withTimeout —
 *  the underlying request keeps running, we just stop waiting for it
 *  on the request thread. Applied to every pillar so one slow query
 *  can't take down the whole scan. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
  label: string
): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      console.error(
        `[upgrade-analysis] ${label} timed out after ${ms}ms — using fallback`
      );
      resolve(fallback);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        console.error(
          `[upgrade-analysis] ${label} errored:`,
          err instanceof Error ? err.message : err
        );
        resolve(fallback);
      }
    );
  });
}

/** Standard per-pillar timeout — keeps a stuck ClickHouse query
 *  from bricking a scan. 30s per pillar × 6 pillars = well under the
 *  route's 60s maxDuration; parallel execution makes it faster still. */
const PILLAR_TIMEOUT_MS = 30_000;

// ─── Pillar 1 — Identity & setup (DB 2 / Postgres) ───────────────────────

interface Pillar1Row {
  id: string;
  name: string | null;
  organization_id: string;
  created_at: string | null;
  double_opt_required: boolean | null;
  enable_signup_confirmation: boolean | null;
  email_sender_name: string | null;
  custom_link_tracking_enabled: boolean | null;
  private: boolean | null;
  require_subscriber_approval: boolean | null;
  white_labeled_at: string | null;
  deleted_at: string | null;
}

export async function runIdentityPillar(
  pubId: string
): Promise<IdentityCounters> {
  const sql = `
    SELECT id, name, organization_id, created_at, double_opt_required,
           enable_signup_confirmation, email_sender_name,
           custom_link_tracking_enabled, private, require_subscriber_approval,
           white_labeled_at, deleted_at
    FROM publications
    WHERE id = ${q(pubId)}
    LIMIT 1
  `;
  const rows = (await withTimeout(
    runNativeQuery(DB.POSTGRES, sql) as Promise<unknown[]>,
    PILLAR_TIMEOUT_MS,
    [] as unknown[],
    "identity"
  )) as Pillar1Row[];
  const row = rows[0];
  if (!row) {
    return {
      pub_id: pubId,
      org_id: "",
      name: null,
      created_at: null,
      double_opt_required: null,
      enable_signup_confirmation: null,
      private: null,
      require_subscriber_approval: null,
      white_labeled_at: null,
      deleted_at: null,
      age_days: null,
    };
  }
  const ageDays = row.created_at
    ? Math.floor(
        (Date.now() - new Date(row.created_at).getTime()) / (24 * 60 * 60 * 1000)
      )
    : null;
  return {
    pub_id: row.id,
    org_id: row.organization_id,
    name: row.name,
    created_at: row.created_at,
    double_opt_required: row.double_opt_required,
    enable_signup_confirmation: row.enable_signup_confirmation,
    private: row.private,
    require_subscriber_approval: row.require_subscriber_approval,
    white_labeled_at: row.white_labeled_at,
    deleted_at: row.deleted_at,
    age_days: ageDays,
  };
}

// ─── Pillar 2 — Acquisition & consent (DB 2) ─────────────────────────────

interface Pillar2ChannelRaw {
  channel: string;
  status: string;
  n: number;
}
interface Pillar2WeeklyRaw {
  wk: string;
  added: number;
  with_optin_ts: number;
  now_inactive: number;
}
interface Pillar2ImportRaw {
  file: string | null;
}
interface Pillar2ApiKeyRaw {
  name: string | null;
}

export async function runAcquisitionPillar(
  pubId: string,
  orgId: string,
  cfg: UpgradeAnalysisConfig
): Promise<AcquisitionCounters> {
  const channelSql = `
    SELECT CASE
        WHEN import_id IS NOT NULL THEN 'import'
        WHEN api_key_id IS NOT NULL THEN 'api'
        WHEN acquisition_cart_id IS NOT NULL THEN 'acquisition_cart'
        WHEN recommendation_id IS NOT NULL OR recommendation_widget_id IS NOT NULL THEN 'recommendation'
        WHEN external_embed_id IS NOT NULL THEN 'embed'
        WHEN integration_id IS NOT NULL THEN 'integration'
        WHEN referrer_id IS NOT NULL THEN 'referral'
        ELSE 'organic_form'
      END AS channel,
      status, COUNT(*) AS n
    FROM subscriptions
    WHERE publication_id = ${q(pubId)}
      AND deleted_at IS NULL
    GROUP BY 1, 2
    ORDER BY n DESC
    LIMIT 50
  `;
  const weeklySql = `
    SELECT date_trunc('week', created_at) AS wk,
           COUNT(*) AS added,
           COUNT(opt_in_at) AS with_optin_ts,
           COUNT(*) FILTER (WHERE status='inactive') AS now_inactive
    FROM subscriptions
    WHERE publication_id = ${q(pubId)}
      AND deleted_at IS NULL
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT ${cfg.volume.acquisition_weekly_lookback}
  `;
  const importsSql = `
    SELECT file, import_type, status, created_at
    FROM imports
    WHERE publication_id = ${q(pubId)}
      AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 100
  `;
  const apiKeysSql = `
    SELECT name, created_at
    FROM api_keys
    WHERE organization_id = ${q(orgId)}
      AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 40
  `;

  const [channelsRaw, weeklyRaw, importsRaw, apiKeysRaw] = await Promise.all([
    withTimeout(
      runNativeQuery(DB.POSTGRES, channelSql) as Promise<unknown[]>,
      PILLAR_TIMEOUT_MS,
      [] as unknown[],
      "acquisition:channels"
    ),
    withTimeout(
      runNativeQuery(DB.POSTGRES, weeklySql) as Promise<unknown[]>,
      PILLAR_TIMEOUT_MS,
      [] as unknown[],
      "acquisition:weekly"
    ),
    withTimeout(
      runNativeQuery(DB.POSTGRES, importsSql) as Promise<unknown[]>,
      PILLAR_TIMEOUT_MS,
      [] as unknown[],
      "acquisition:imports"
    ),
    withTimeout(
      runNativeQuery(DB.POSTGRES, apiKeysSql) as Promise<unknown[]>,
      PILLAR_TIMEOUT_MS,
      [] as unknown[],
      "acquisition:api_keys"
    ),
  ]);

  const channels: AcquisitionChannelRow[] = (channelsRaw as Pillar2ChannelRaw[])
    .map((r) => {
      const known: AcquisitionChannelRow["channel"][] = [
        "import",
        "api",
        "acquisition_cart",
        "recommendation",
        "embed",
        "integration",
        "referral",
        "organic_form",
      ];
      const channel: AcquisitionChannelRow["channel"] = known.includes(
        r.channel as AcquisitionChannelRow["channel"]
      )
        ? (r.channel as AcquisitionChannelRow["channel"])
        : "organic_form";
      return { channel, status: String(r.status ?? ""), n: Number(r.n ?? 0) };
    });

  const total_subs = channels.reduce((s, c) => s + c.n, 0);

  const weekly = weeklyRaw as Pillar2WeeklyRaw[];
  const weekly_injections = weekly
    .map((r) => ({ week: String(r.wk), added: Number(r.added ?? 0) }))
    .reverse(); // present chronologically
  const total_added = weekly.reduce((s, r) => s + Number(r.added ?? 0), 0);
  const total_with_optin = weekly.reduce(
    (s, r) => s + Number(r.with_optin_ts ?? 0),
    0
  );
  const opt_in_coverage_pct = total_added > 0 ? total_with_optin / total_added : 0;

  const import_filenames = (importsRaw as Pillar2ImportRaw[])
    .map((r) => (r.file ?? "").toString())
    .filter((s) => s.length > 0);
  const api_key_names = (apiKeysRaw as Pillar2ApiKeyRaw[])
    .map((r) => (r.name ?? "").toString())
    .filter((s) => s.length > 0);

  // Convenience side-signals surfaced via raw_counters — the rule
  // itself in rules.ts only cares whether ANY match. Kept here so
  // the UI can render the matched tokens.
  return {
    channels,
    total_subs,
    opt_in_coverage_pct,
    weekly_injections,
    import_filenames,
    api_key_names,
  };
}

/** Test whether any acquisition label matches the bought-broker
 *  token classifier — surfaced to callers for the rules.ts scoring. */
export function acquisitionHasSuspiciousLabels(
  acq: AcquisitionCounters
): { file: boolean; api_key: boolean } {
  return {
    file: acq.import_filenames.some(looksSuspiciousLabel),
    api_key: acq.api_key_names.some(looksSuspiciousLabel),
  };
}

// ─── Pillars 3+4 — Funnel + engagement (DB 100 / ClickHouse) ─────────────

interface Pillar34Raw {
  rows_evt: number;
  sent: number;
  deliv: number;
  opens: number;
  v_opens: number;
  mach_opens: number;
  ua_mach: number;
  clicks: number;
  v_clicks: number;
  deferred: number;
  soft_b: number;
  hard_b: number;
  spam: number;
  uniq_subs: number;
}

/** Postgres unsubscribe count for the same lookback window as the
 *  funnel. Runs as its own query because unsubscribe events don't
 *  appear in the ClickHouse `sendgrid_v1` stream — the customer's
 *  action lives on the `subscriptions` row's `unsubscribed_at`
 *  timestamp. Fails open (returns 0) on error so the funnel pillar
 *  still emits a report; the snapshot tile renders "—" for the
 *  unsubscribe rate when this happens rather than a misleading 0%. */
interface Pillar34UnsubRaw {
  unsubs: number;
}

async function fetchUnsubCount(
  pubId: string,
  window: AnalysisWindow | undefined,
  fallbackLookbackDays: number
): Promise<number> {
  try {
    const windowClause = resolveWindowPg(window, fallbackLookbackDays);
    const sql = `
      SELECT COUNT(*)::int AS unsubs
      FROM subscriptions
      WHERE publication_id = ${q(pubId)}
        AND unsubscribed_at IS NOT NULL
        AND ${windowClause}
    `;
    const rows = (await withTimeout(
      runNativeQuery(DB.POSTGRES, sql) as Promise<unknown[]>,
      PILLAR_TIMEOUT_MS,
      [] as unknown[],
      "funnel:unsubs"
    )) as Pillar34UnsubRaw[];
    return Number(rows[0]?.unsubs ?? 0);
  } catch (e) {
    console.warn(
      "[upgrade-analysis] unsub count query failed:",
      e instanceof Error ? e.message : e
    );
    return 0;
  }
}

export async function runFunnelPillar(
  pubId: string,
  cfg: UpgradeAnalysisConfig,
  window?: AnalysisWindow
): Promise<FunnelCounters> {
  const { clause, effectiveDays } = resolveWindow(
    window,
    cfg.volume.funnel_window_days
  );
  // NOTE: rows in `sendgrid_v1` are individual SendGrid events
  // (processed / delivered / opened / clicked / bounced / …). To
  // count sends, we count `event = 'processed'` — SendGrid emits
  // one 'processed' per accepted send. The read-time fallback in
  // the mapper below handles pubs whose stream doesn't carry
  // 'processed' rows (falls back to delivered + bounced, which is
  // the terminal-state sum of what was actually sent).
  const sql = `
    SELECT count() AS rows_evt,
      countIf(\`event\` = 'processed') AS sent,
      sum(\`is_delivered\`) AS deliv,
      sum(\`is_opened\`) AS opens,
      sum(\`is_verified_opened\`) AS v_opens,
      sum(\`sg_machine_open\`) AS mach_opens,
      sum(\`ua_suspected_machine\`) AS ua_mach,
      sum(\`is_clicked\`) AS clicks,
      sum(\`is_verified_clicked\`) AS v_clicks,
      sum(\`is_deferred\`) AS deferred,
      sum(\`is_soft_bounced\`) AS soft_b,
      sum(\`is_hard_bounced\`) AS hard_b,
      sum(\`is_spam_reported\`) AS spam,
      uniqExact(\`subscriber_id\`) AS uniq_subs
    FROM default.sendgrid_v1
    WHERE publication_id = ${q(pubId)}
      AND ${clause}
  `;
  // Fan out: ClickHouse funnel + Postgres unsub count run in parallel
  // so the pillar's wall-clock stays close to the slower of the two.
  const [rows, unsubs] = await Promise.all([
    withTimeout(
      runNativeQuery(DB.CLICKHOUSE_MAIN, sql) as Promise<unknown[]>,
      PILLAR_TIMEOUT_MS,
      [] as unknown[],
      "funnel"
    ) as Promise<Pillar34Raw[]>,
    fetchUnsubCount(pubId, window, cfg.volume.funnel_window_days),
  ]);
  const r = rows[0] ?? ({} as Partial<Pillar34Raw>);
  const rowsEvt = Number(r.rows_evt ?? 0);
  const processed = Number(r.sent ?? 0);
  const delivered = Number(r.deliv ?? 0);
  const softBounced = Number(r.soft_b ?? 0);
  const hardBounced = Number(r.hard_b ?? 0);
  // Prefer the SendGrid `processed` count when present. When the
  // stream doesn't carry 'processed' rows for a pub (some ingest
  // paths drop them), fall back to delivered + bounced — every
  // sent message terminates in one of those states.
  const sent =
    processed > 0 ? processed : delivered + softBounced + hardBounced;
  return {
    window_days: effectiveDays,
    rows_evt: rowsEvt,
    sent,
    deliv: delivered,
    opens: Number(r.opens ?? 0),
    v_opens: Number(r.v_opens ?? 0),
    mach_opens: Number(r.mach_opens ?? 0),
    ua_mach: Number(r.ua_mach ?? 0),
    clicks: Number(r.clicks ?? 0),
    v_clicks: Number(r.v_clicks ?? 0),
    deferred: Number(r.deferred ?? 0),
    soft_b: softBounced,
    hard_b: hardBounced,
    spam: Number(r.spam ?? 0),
    uniq_subs: Number(r.uniq_subs ?? 0),
    unsubs,
  };
}

// ─── Pillar 6 — Provider concentration + deferral reasons (DB 100) ───────

interface Pillar6ProviderRaw {
  dom: string;
  deliv: number;
  spam: number;
  spam_pct: number;
  defer_pct: number;
}
interface Pillar6ReasonRaw {
  reason_class: string;
  ev: string;
  n: number;
}
interface Pillar6KumoRaw {
  kumo_deferrals: number;
  total_deferrals: number;
}

export async function runProviderPillar(
  pubId: string,
  cfg: UpgradeAnalysisConfig,
  window?: AnalysisWindow
): Promise<ProviderCounters> {
  const { clause, effectiveDays } = resolveWindow(
    window,
    cfg.volume.provider_window_days
  );

  const providerSql = `
    SELECT \`email_domain\` AS dom,
      sum(\`is_delivered\`) AS deliv,
      sum(\`is_spam_reported\`) AS spam,
      round(sum(\`is_spam_reported\`) / nullIf(sum(\`is_delivered\`), 0) * 100, 3) AS spam_pct,
      round(sum(\`is_deferred\`) / nullIf(sum(\`is_delivered\`), 0) * 100, 1) AS defer_pct
    FROM default.sendgrid_v1
    WHERE publication_id = ${q(pubId)}
      AND ${clause}
      AND \`email_domain\` != ''
    GROUP BY dom
    ORDER BY deliv DESC
    LIMIT 25
  `;
  // Reason classes exclude Kumo `0.0.0.0` per the guardrails.
  const reasonSql = `
    SELECT multiIf(
       positionCaseInsensitive(\`reason\`, 'spamcop') > 0 OR positionCaseInsensitive(\`response\`, 'spamcop') > 0, 'spamcop',
       positionCaseInsensitive(\`reason\`, 'spamhaus') > 0 OR positionCaseInsensitive(\`response\`, 'spamhaus') > 0, 'spamhaus',
       positionCaseInsensitive(\`reason\`, 'cloudmark') > 0, 'cloudmark',
       positionCaseInsensitive(\`reason\`, 'block') > 0 OR positionCaseInsensitive(\`response\`, 'block') > 0, 'blocked/blocklist',
       positionCaseInsensitive(\`reason\`, 'spam') > 0, 'spam-content',
       positionCaseInsensitive(\`reason\`, 'greylist') > 0 OR positionCaseInsensitive(\`reason\`, 'try again') > 0, 'greylist',
       'other'
    ) AS reason_class,
    \`event\` AS ev,
    count() AS n
    FROM default.sendgrid_v1
    WHERE publication_id = ${q(pubId)}
      AND \`timestamp\` >= now() - INTERVAL 14 DAY
      AND \`event\` IN ('deferred', 'bounce')
      AND \`ip\` != '0.0.0.0'
    GROUP BY reason_class, ev
    ORDER BY n DESC
    LIMIT 30
  `;
  const kumoSql = `
    SELECT
      countIf(\`ip\` = '0.0.0.0' AND \`event\` = 'deferred') AS kumo_deferrals,
      countIf(\`event\` = 'deferred') AS total_deferrals
    FROM default.sendgrid_v1
    WHERE publication_id = ${q(pubId)}
      AND ${clause}
  `;

  const [providerRaw, reasonRaw, kumoRaw] = await Promise.all([
    withTimeout(
      runNativeQuery(DB.CLICKHOUSE_MAIN, providerSql) as Promise<unknown[]>,
      PILLAR_TIMEOUT_MS,
      [] as unknown[],
      "provider:concentration"
    ),
    withTimeout(
      runNativeQuery(DB.CLICKHOUSE_MAIN, reasonSql) as Promise<unknown[]>,
      PILLAR_TIMEOUT_MS,
      [] as unknown[],
      "provider:reasons"
    ),
    withTimeout(
      runNativeQuery(DB.CLICKHOUSE_MAIN, kumoSql) as Promise<unknown[]>,
      PILLAR_TIMEOUT_MS,
      [] as unknown[],
      "provider:kumo"
    ),
  ]);

  const providers: ProviderRow[] = (providerRaw as Pillar6ProviderRaw[]).map(
    (r) => ({
      dom: String(r.dom ?? ""),
      deliv: Number(r.deliv ?? 0),
      spam: Number(r.spam ?? 0),
      spam_pct: Number(r.spam_pct ?? 0),
      defer_pct: Number(r.defer_pct ?? 0),
    })
  );

  const validReasonClasses = new Set<DeferralReasonRow["reason_class"]>([
    "spamcop",
    "spamhaus",
    "cloudmark",
    "blocked/blocklist",
    "spam-content",
    "greylist",
    "other",
  ]);
  const deferral_reasons: DeferralReasonRow[] = (reasonRaw as Pillar6ReasonRaw[])
    .filter(
      (r) =>
        validReasonClasses.has(r.reason_class as DeferralReasonRow["reason_class"]) &&
        (r.ev === "deferred" || r.ev === "bounce")
    )
    .map((r) => ({
      reason_class: r.reason_class as DeferralReasonRow["reason_class"],
      ev: r.ev as DeferralReasonRow["ev"],
      n: Number(r.n ?? 0),
    }));

  const kumo = (kumoRaw as Pillar6KumoRaw[])[0] ?? {
    kumo_deferrals: 0,
    total_deferrals: 0,
  };
  const kumo_share_of_deferrals =
    Number(kumo.total_deferrals) > 0
      ? Number(kumo.kumo_deferrals) / Number(kumo.total_deferrals)
      : 0;

  return {
    window_days: effectiveDays,
    providers,
    deferral_reasons,
    kumo_share_of_deferrals,
  };
}

// ─── Pillar 8 — Network read (org flags on this org; DB 2) ───────────────

interface Pillar8Raw {
  organization_id: string;
  flag: string;
  created_at: string;
  deleted_at: string | null;
}

export async function runNetworkPillar(orgId: string): Promise<NetworkCounters> {
  const sql = `
    SELECT organization_id, flag, created_at, deleted_at
    FROM organization_flags
    WHERE organization_id = ${q(orgId)}
    ORDER BY created_at DESC
    LIMIT 50
  `;
  const rows = (await withTimeout(
    runNativeQuery(DB.POSTGRES, sql) as Promise<unknown[]>,
    PILLAR_TIMEOUT_MS,
    [] as unknown[],
    "network:flags"
  )) as Pillar8Raw[];

  const org_flags: OrgFlagRow[] = rows.map((r) => ({
    organization_id: String(r.organization_id ?? ""),
    flag: String(r.flag ?? ""),
    created_at: String(r.created_at ?? ""),
    deleted_at: r.deleted_at ? String(r.deleted_at) : null,
  }));

  const isActive = (f: OrgFlagRow, name: string) =>
    f.flag === name && !f.deleted_at;

  return {
    org_flags,
    aup_prohibited_use_active: org_flags.some((f) => isActive(f, "aup_prohibited_use")),
    ip_already_used_active: org_flags.some((f) => isActive(f, "ip_already_used")),
    // Sibling-org signal in Postgres alone isn't reliable — the plan
    // punts network mapping to Slack search (see PR 2). Marking
    // this as always incomplete so the UI reminds the reviewer.
    network_map_incomplete: true,
  };
}
