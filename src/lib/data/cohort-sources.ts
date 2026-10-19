import { DB, runNativeQuery, runSavedQuestion } from "../metabase";

/**
 * Where each AM cohort's rows come from.
 *
 * ─── Why this module exists ───────────────────────────────────────
 * Cohorts used to be "a Metabase saved-question id", full stop. That
 * put a load-bearing piece of the dashboard inside a shared BI asset
 * that anyone can edit, that nothing version-controls, and that no
 * review ever sees. It failed exactly the way you'd expect: q24620
 * read from a hand-made table in a scratch schema, the table was
 * dropped on 2026-10-02, and the Past Due tab served the same frozen
 * rows for seventeen days.
 *
 * So a cohort is now EITHER a saved question or SQL that lives in this
 * repo. Repo SQL is the better default for anything the dashboard
 * depends on: it diffs, it reviews, it ships atomically with the code
 * that reads it, and nobody can quietly repoint it at a different
 * table.
 *
 * Both the twice-daily sync (scripts/sync.ts) and the live fallback in
 * engines/am-cohorts.ts resolve cohorts through here, deliberately. If
 * those two drifted apart, the fallback could keep hitting a broken
 * question while the sync used good SQL — a split brain that would be
 * horrible to diagnose from the symptoms.
 */

export type CohortSource =
  | { kind: "question"; label: string; questionId: number }
  | { kind: "native"; label: string; databaseId: number; sql: string };

/**
 * Past-due subscriptions, with the owning CSM where we can resolve one.
 *
 * Replaces Metabase q24620, which selected from
 * `cohort_analysis.past_due_subscriptions_w_customer_details` — a table
 * that no longer exists and that no pipeline recreates.
 *
 * ─── Why not cohort_analysis.stripe_subscriptions ─────────────────
 * It looks like the obvious swap: same columns, already a view, no
 * dblink to write by hand. It is also WRONG here, and quietly so. Its
 * inner query ends with `JOIN cc_addresses` — an INNER join to card
 * payment methods that carry a billing address. Any past-due sub whose
 * card was pulled or never had an address on file disappears, which is
 * disproportionately the population this report exists to surface.
 * Measured 2026-10-19: Stripe held 305 past-due subscriptions, that
 * view exposed 51. Using it would have looked like a fix while hiding
 * five accounts in six.
 *
 * So we go to the same Redshift source that view wraps, keeping its
 * column contract and ARR derivation, minus the address restriction.
 *
 * ─── Shape contract ───────────────────────────────────────────────
 * Column names here feed mapPastDue() in engines/am-cohorts.ts
 * directly. Renaming one silently nulls a field on the Past Due tab —
 * change both together.
 *
 * `dblink` is a Postgres extension, so this MUST run against
 * DB.POSTGRES (Swarm - Production Replica). Pointed at the Redshift
 * database it fails, because there it would already be inside the
 * database it's trying to reach out to.
 */
export const PAST_DUE_SQL = `
select
  hb.customer_success_manager,
  pd.customer_id,
  pd.email,
  pd.subscription_id,
  pd.subscription_status,
  pd.price_name,
  pd.arr_cents,
  pd.charge_amount_cents,
  pd.charge_status,
  pd.charge_attempted_at,
  pd.failure_code,
  pd.failure_message,
  pd.auto_upgrade
from dblink('redshift', '
  select
    subscriptions.customer_id,
    customers.email,
    subscriptions.id as subscription_id,
    subscriptions.status as subscription_status,
    prices.nickname as price_name,
    case
      when prices.recurring_interval = ''month'' and prices.nickname ilike ''% 3 %'' then prices.unit_amount * 4
      when prices.recurring_interval = ''month'' and prices.nickname ilike ''% 6 %'' then prices.unit_amount * 2
      when prices.recurring_interval = ''month'' then prices.unit_amount * 12
      else prices.unit_amount
    end as arr_cents,
    charges.amount as charge_amount_cents,
    charges.status as charge_status,
    charges.created as charge_attempted_at,
    charges.failure_code,
    charges.failure_message,
    case when sm.value = ''true'' then ''true'' else ''false'' end as auto_upgrade
  from stripe.stripe.subscriptions
  left join stripe.stripe.invoices on invoices.id = subscriptions.latest_invoice_id
  left join stripe.stripe.charges on invoices.charge_id = charges.id
  left join stripe.stripe.invoice_line_items ili on invoices.id = ili.invoice_id
  left join stripe.stripe.prices on ili.price_id = prices.id
  join stripe.stripe.customers on subscriptions.customer_id = customers.id
  left join stripe.stripe.subscriptions_metadata sm
    on subscriptions.id = sm.subscription_id and sm.key = ''auto_upgrade''
  where subscriptions.status = ''past_due''
    -- Carried from the original view: without it invoice_line_items
    -- fans a subscription out into one row per line.
    and (ili.invoice_item_id is null or ili.description like ''Remaining time on beehiiv%'')
') as pd(
  customer_id         varchar(65535),
  email               varchar(65535),
  subscription_id     varchar(65535),
  subscription_status varchar(65535),
  price_name          varchar(65535),
  arr_cents           bigint,
  charge_amount_cents bigint,
  charge_status       varchar(65535),
  charge_attempted_at timestamp,
  failure_code        varchar(65535),
  failure_message     varchar(65535),
  auto_upgrade        varchar(65535)
)
left join cohort_analysis.hubspot_csm_companies hb
  on pd.customer_id = hb.stripe_customer_id
order by pd.arr_cents desc nulls last
`.trim();

export const PAST_DUE_SOURCE: CohortSource = {
  kind: "native",
  label: "past-due (repo SQL, replaces q24620)",
  databaseId: DB.POSTGRES,
  sql: PAST_DUE_SQL,
};

/** Still a saved question: q13268 works and reads from maintained
 *  tables. Left alone on purpose — moving it here would be churn
 *  without a reason, and the point isn't that questions are bad, it's
 *  that a question reading a scratch table was. */
export const APPROACHING_ENT_SOURCE: CohortSource = {
  kind: "question",
  label: "approaching-enterprise (q13268)",
  questionId: 13268,
};

/** Saved-question id for provenance on the snapshot payload, or null
 *  when the rows came from SQL in this repo. */
export function sourceQuestionId(source: CohortSource): number | null {
  return source.kind === "question" ? source.questionId : null;
}

export async function runCohortSource(
  source: CohortSource
): Promise<Record<string, unknown>[]> {
  if (source.kind === "question") return runSavedQuestion(source.questionId);
  return runNativeQuery(source.databaseId, source.sql);
}
