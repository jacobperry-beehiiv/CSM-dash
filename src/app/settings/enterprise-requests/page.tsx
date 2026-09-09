import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import {
  loadEnterpriseRequestsSnapshot,
  loadOrphans,
  loadShippedCursor,
  loadSlackIntakeCursor,
} from "@/lib/data/enterprise-requests";
import { fmtDate } from "@/components/format";
import { ResyncControls } from "@/components/enterprise-requests/resync-controls";

export const dynamic = "force-dynamic";

/**
 * /settings/enterprise-requests — hub page for the Enterprise Request
 * Loop tooling. Renders the resync controls + a status strip showing
 * when each sweep last ran, and links to the admin queues below.
 *
 * Flag-gated on `enterprise-requests`; 404s for unallowlisted users
 * (dark-launch posture matching /settings/customer-folders and the
 * queue pages under this namespace).
 */
export default async function EnterpriseRequestsSettingsPage() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!(await isFeatureEnabledFor("enterprise-requests", email))) {
    notFound();
  }

  const [snapshot, shippedCursor, slackIntakeCursor, orphansBlob] =
    await Promise.all([
      loadEnterpriseRequestsSnapshot(),
      loadShippedCursor(),
      loadSlackIntakeCursor(),
      loadOrphans(),
    ]);

  // Rough row-count summary so an admin can eyeball snapshot health
  // without opening the KV browser.
  let totalRows = 0;
  let liveRows = 0;
  let slackIntakeRows = 0;
  for (const bucket of Object.values(snapshot.rows)) {
    for (const row of Object.values(bucket)) {
      totalRows += 1;
      if (
        row.derived_state === "Live" ||
        row.derived_state === "Live, possibly in beta"
      ) {
        liveRows += 1;
      }
      if (row.intake_source === "slack_intake") slackIntakeRows += 1;
    }
  }
  const pendingOrphans = Object.values(orphansBlob.orphans).filter(
    (o) => o.status === "pending"
  ).length;

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg mb-1">
        Enterprise Request Loop
      </h1>
      <p className="text-sm text-muted mb-6 max-w-prose">
        Feature-request tracking end-to-end. The nightly cron runs the
        full chain at ~12:30 UTC; use the buttons below to trigger a
        resync on demand (after a Linear-side edit, a manual customer
        map approval, or when validating a new post in
        <code className="font-mono text-xs">
          {" "}#enterprise-bugs-and-feature-requests
        </code>
        ).
      </p>

      <section className="mb-8 rounded-xl border border-border bg-canvas p-4">
        <h2 className="text-sm font-semibold text-fg mb-2">Snapshot status</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <Stat
            label="Rows in snapshot"
            value={totalRows.toString()}
            hint={
              snapshot.last_run
                ? `${snapshot.last_run.pulled} issues pulled, ${snapshot.last_run.matched} matched`
                : "No sync run yet."
            }
          />
          <Stat
            label="Live / shipping"
            value={liveRows.toString()}
            hint="Rows in Live or Live-possibly-in-beta buckets."
          />
          <Stat
            label="Slack-only"
            value={slackIntakeRows.toString()}
            hint="Rows discovered via #enterprise-bugs-and-fr with no Linear customer_need yet."
          />
          <Stat
            label="Orphaned shipments"
            value={pendingOrphans.toString()}
            hint="Shipped-channel hits pending admin review (>14d old)."
          />
        </div>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3 text-[11px] text-muted">
          <div>
            Linear sync ran: <strong>{fmtDate(snapshot.fetched_at)}</strong>
          </div>
          <div>
            Shipped-sweep cursor:{" "}
            <strong>{fmtDate(shippedCursor.updated_at)}</strong>
          </div>
          <div>
            Slack-intake cursor:{" "}
            <strong>{fmtDate(slackIntakeCursor.updated_at)}</strong>
          </div>
        </div>
      </section>

      <ResyncControls />

      <section className="mt-8 rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold text-fg mb-2">Admin queues</h2>
        <ul className="text-sm space-y-1">
          <li>
            <Link
              href="/settings/enterprise-requests/unmatched"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              Unmatched Linear customers →
            </Link>
          </li>
          <li>
            <Link
              href="/settings/enterprise-requests/orphans"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              Orphaned shipments →
            </Link>
          </li>
        </ul>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-subtle">
        {label}
      </div>
      <div className="text-lg font-semibold text-fg tabular-nums">{value}</div>
      <div className="text-[10px] text-muted mt-0.5">{hint}</div>
    </div>
  );
}
