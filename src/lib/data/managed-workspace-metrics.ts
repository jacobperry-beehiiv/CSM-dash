import { DB, runNativeQuery } from "../metabase";

/**
 * Live metrics for a managed workspace, read straight from ClickHouse
 * by workspace_id.
 *
 * ─── Why not reuse the snapshot ───────────────────────────────────
 * The snapshot is the output of q10600, which starts
 * `from hubspot_csm_companies` — a managed workspace has no CSM-assigned
 * HubSpot company, so it is absent from that result set by
 * construction. Filtering the snapshot differently cannot help; the
 * row was never there. So we go to the same ClickHouse tables q10600
 * draws from, keyed on organization id instead of stripe_customer_id.
 *
 * SQL lives in this repo rather than a saved Metabase question, for
 * the reason the past-due feed was moved here: a saved question is a
 * shared asset anyone can repoint, nothing version-controls it, and no
 * review ever sees it.
 *
 * ─── Cost ─────────────────────────────────────────────────────────
 * The subscriber count is the expensive half. It is constrained to the
 * requested organizations in the subquery's own WHERE clause rather
 * than being joined and filtered afterwards, so ClickHouse never
 * materialises counts for the whole table. Call sites pass a handful
 * of ids (the children of one account), not a book.
 */

export interface ManagedWorkspaceMetrics {
  workspace_id: string;
  workspace_name: string | null;
  owner_email: string | null;
  /** Raw beehiiv plan slug ("scale", "max", "custom"). */
  plan_name: string | null;
  /** Stripe's own plan label ("Scale", "Enterprise") — matches what
   *  the book shows for a normal account, so the two read the same. */
  stripe_plan: string | null;
  /** Drives the Stripe deep link, same as a book row's. Present on
   *  non-enterprise orgs too — they're still paying customers. */
  stripe_customer_id: string | null;
  max_subscriptions: number | null;
  active_subs: number | null;
  mrr: number | null;
  /** mrr * 12, precomputed so callers don't each reinvent it. */
  arr: number | null;
  /** Next Stripe charge. ISO, or null when there's no live sub. */
  next_charge: string | null;
  /** ISO timestamp, or null when they have never sent. */
  last_send: string | null;
}

/** ClickHouse returns a zero DateTime rather than null for "no rows"
 *  on a max() over an empty set. Rendering 1970 as a send date would
 *  be worse than showing nothing, and "never sent" is a real and
 *  interesting state for a managed workspace. */
function normalizeSend(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.startsWith("1970-01-01")) return null;
  return raw;
}

function asNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export async function fetchManagedWorkspaceMetrics(
  workspaceIds: string[]
): Promise<Map<string, ManagedWorkspaceMetrics>> {
  const out = new Map<string, ManagedWorkspaceMetrics>();
  const unique = [...new Set(workspaceIds.filter(Boolean))];
  if (unique.length === 0) return out;

  // ids are beehiiv organization UUIDs. Quote-escape anyway rather
  // than trusting the caller — these arrive from a KV blob a CSM can
  // write into via the link endpoint.
  const inList = unique
    .map((id) => `'${id.replace(/'/g, "''")}'`)
    .join(", ");

  const sql = `
with targets as (
  select o.id, o.name as org_name, o.plan_id, o.plan_price_id, o.owner_id,
         o.stripe_customer_id as stripe_customer_id
  from (select * from swarm_clickpipes.organizations FINAL) o
  where o.id in (${inList})
)
select
  t.id as workspace_id,
  t.org_name as workspace_name,
  max(u.email) as owner_email,
  any(pl.name) as plan_name,
  any(t.stripe_customer_id) as stripe_customer_id,
  any(fis.plan) as stripe_plan,
  any(fis.mrr) as mrr,
  any(fis.period_end) as next_charge,
  any(pp.max_subscriptions) as max_subscriptions,
  any(subs.active_subs) as active_subs,
  any(sends.last_send) as last_send
from targets t
left join (select * from swarm_clickpipes.users FINAL) u on t.owner_id = u.id
left join swarm_clickpipes.plans pl on t.plan_id = pl.id
left join swarm_clickpipes.plan_prices pp on t.plan_price_id = pp.id
-- Current-month Stripe facts: MRR, plan label and next charge date.
-- Same source q10600 uses for a book row, so a managed workspace's
-- numbers are computed the same way as the account above it.
left join stripe.fact_internal_subscriptions_merge_v1 fis
  on t.stripe_customer_id = fis.customer_id
 and fis.report_month = date_trunc('month', current_date)
left join (
  select p.organization_id as org_id, countDistinct(s.id) as active_subs
  from (select id, organization_id from swarm_clickpipes.publications FINAL) p
  join (select publication_id, id from swarm_clickpipes.subscriptions FINAL
        where status = 'active' and deleted_at = 0 and held_at = 0) s
    on s.publication_id = p.id
  where p.organization_id in (${inList})
  group by 1
) subs on subs.org_id = t.id
left join (
  select p.organization_id as org_id, max(po.send_completed_at) as last_send
  from (select id, organization_id from swarm_clickpipes.publications FINAL) p
  join swarm_clickpipes.posts po on po.publication_id = p.id
  where p.organization_id in (${inList})
    and po.send_status = 2 and po.send_completed_at is not null
  group by 1
) sends on sends.org_id = t.id
group by t.id, t.org_name
`.trim();

  const rows = (await runNativeQuery(DB.CLICKHOUSE_MAIN, sql)) as Array<
    Record<string, unknown>
  >;
  for (const r of rows) {
    const id = asStr(r.workspace_id);
    if (!id) continue;
    const mrr = asNum(r.mrr);
    out.set(id, {
      workspace_id: id,
      workspace_name: asStr(r.workspace_name),
      owner_email: asStr(r.owner_email),
      plan_name: asStr(r.plan_name),
      stripe_plan: asStr(r.stripe_plan),
      stripe_customer_id: asStr(r.stripe_customer_id),
      max_subscriptions: asNum(r.max_subscriptions),
      active_subs: asNum(r.active_subs),
      mrr,
      arr: mrr == null ? null : mrr * 12,
      next_charge: normalizeSend(r.next_charge),
      last_send: normalizeSend(r.last_send),
    });
  }
  return out;
}

/**
 * Typeahead for the "link a managed workspace" picker. Matches on name or
 * on a pasted workspace id.
 *
 * Capped hard: `swarm_clickpipes.organizations` has ~667k rows and a
 * CSM typing "the" should not pull thousands back. Short queries are
 * rejected outright rather than returning a meaningless first-N.
 */
export interface WorkspaceSearchHit {
  workspace_id: string;
  workspace_name: string | null;
  owner_email: string | null;
  plan_name: string | null;
}

const SEARCH_MIN_CHARS = 3;
const SEARCH_LIMIT = 15;

export async function searchWorkspaces(
  query: string
): Promise<WorkspaceSearchHit[]> {
  const q = query.trim();
  if (q.length < SEARCH_MIN_CHARS) return [];
  const safe = q.replace(/'/g, "''");
  const sql = `
select
  o.id as workspace_id,
  o.name as workspace_name,
  max(u.email) as owner_email,
  any(pl.name) as plan_name
from (select * from swarm_clickpipes.organizations FINAL) o
left join (select * from swarm_clickpipes.users FINAL) u on o.owner_id = u.id
left join swarm_clickpipes.plans pl on o.plan_id = pl.id
where positionCaseInsensitive(o.name, '${safe}') > 0
   or toString(o.id) = '${safe}'
group by o.id, o.name
order by length(o.name) asc
limit ${SEARCH_LIMIT}
`.trim();
  const rows = (await runNativeQuery(DB.CLICKHOUSE_MAIN, sql)) as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    workspace_id: String(r.workspace_id ?? ""),
    workspace_name: asStr(r.workspace_name),
    owner_email: asStr(r.owner_email),
    plan_name: asStr(r.plan_name),
  }));
}
