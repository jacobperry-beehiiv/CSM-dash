import Link from "next/link";
import { runAssignAudit } from "@/lib/engines/assign-audit";
import { hubspotCompanyUrl } from "@/lib/links";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "@bot assign audit — CSM Mission Control",
};

/**
 * /admin/assign-audit — read-only recovery-triage view.
 *
 * The @bot assign flow was hitting Vercel's 15s serverless timeout
 * for the ~3 months between 2026-06-23 (template seeding shipped)
 * and 2026-09-22 (PR #254 moved the heavy work to a background
 * endpoint). This page enumerates every assigned account whose four
 * downstream signals — the three HubSpot fields the assign flow
 * writes (`company_status`, `risk_level__csm_`, `customer_folder`)
 * plus the CSM's `slack_assign` todo batch — don't all look landed,
 * so a CSM can decide per-row which recovery path applies:
 *
 *   • Missing status/risk_level  → step-1 HubSpot PATCH never ran;
 *                                  re-run @bot assign (safe now
 *                                  post-#254, dedupe is idempotent)
 *   • Missing todos              → /api/lifecycle/backfill-onboarding
 *                                  (button on the Lifecycle board's
 *                                  Onboarding sub-tab when the card's
 *                                  checklist is empty)
 *   • Missing customer_folder    → /settings/customer-folders sweep
 *                                  (fuzzy-matches orphaned Drive
 *                                  folders back to HubSpot)
 *   • Missing all four           → re-run @bot assign — nothing after
 *                                  step 1 landed
 *
 * Admin-gated by the layout — see src/app/admin/layout.tsx.
 */
export default async function AssignAuditPage() {
  const report = await runAssignAudit();

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-xl font-semibold text-fg">@bot assign audit</h2>
        <p className="text-sm text-muted mt-1 max-w-3xl">
          Accounts assigned since{" "}
          <code className="font-mono">{report.window_start}</code> whose
          @bot assign flow appears to have partially landed. Cross-
          references the three HubSpot fields the flow writes
          (Company Status, Risk Level, Customer Folder) plus the
          CSM&apos;s slack_assign todo batch. Read-only — recovery
          actions link out to the existing tools.
        </p>
      </header>

      <SummaryCards report={report} />

      {report.affected.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-6 text-sm text-muted">
          Nothing to backfill — every assignment in the affected window has
          all three HubSpot fields set and a matching todo batch.
        </div>
      ) : (
        <AuditTable rows={report.affected} />
      )}

      <footer className="text-xs text-muted">
        Ran at {new Date(report.ran_at).toLocaleString()} · scanned{" "}
        {report.scanned_customers} customers across {report.scanned_csms} CSMs
        · signals read from the current snapshot (twice-daily refresh)
      </footer>
    </div>
  );
}

function SummaryCards({
  report,
}: {
  report: Awaited<ReturnType<typeof runAssignAudit>>;
}) {
  const cells = [
    {
      key: "total",
      label: "Total affected",
      count: report.totals.total_affected,
      hint: "Rows missing at least one signal.",
    },
    {
      key: "status",
      label: "Missing Company Status",
      count: report.totals.missing_status,
      hint: "HubSpot property_company_status empty → step 1 didn't land.",
    },
    {
      key: "risk",
      label: "Missing Risk Level",
      count: report.totals.missing_risk_level,
      hint: "HubSpot risk_level__csm_ empty → step 1 didn't land.",
    },
    {
      key: "folder",
      label: "Missing Customer Folder",
      count: report.totals.missing_customer_folder,
      hint: "HubSpot customer_folder empty → step 4/4b/5 didn't land.",
    },
    {
      key: "todos",
      label: "Missing todo batch",
      count: report.totals.missing_todos,
      hint: "No open slack_assign batch on the CSM's list → step 3 didn't land.",
    },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      {cells.map((cell) => (
        <div
          key={cell.key}
          className="rounded-lg border border-border bg-surface p-4"
        >
          <div className="text-2xl font-semibold text-fg">{cell.count}</div>
          <div className="text-sm text-fg mt-1">{cell.label}</div>
          <div className="text-[11px] text-muted mt-1 leading-snug">
            {cell.hint}
          </div>
        </div>
      ))}
    </div>
  );
}

function AuditTable({
  rows,
}: {
  rows: Awaited<ReturnType<typeof runAssignAudit>>["affected"];
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-surface-2 text-fg text-left text-xs uppercase tracking-wider">
          <tr>
            <th className="px-3 py-2 font-medium">Company</th>
            <th className="px-3 py-2 font-medium">CSM</th>
            <th className="px-3 py-2 font-medium">Reassigned</th>
            <th className="px-3 py-2 font-medium text-center">Status</th>
            <th className="px-3 py-2 font-medium text-center">Risk</th>
            <th className="px-3 py-2 font-medium text-center">Folder</th>
            <th className="px-3 py-2 font-medium text-center">Todos</th>
            <th className="px-3 py-2 font-medium">Recovery</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border bg-surface">
          {rows.map((row) => {
            const hubspot = hubspotCompanyUrl(row.hubspot_company_id);
            return (
              <tr key={row.workspace_id}>
                <td className="px-3 py-2 align-top">
                  <div className="font-medium text-fg">
                    {row.company_name?.trim() ||
                      row.workspace_name ||
                      row.workspace_id}
                  </div>
                  <div className="text-[11px] text-muted mt-0.5 flex gap-2">
                    {hubspot ? (
                      <a
                        className="underline hover:no-underline"
                        href={hubspot}
                        target="_blank"
                        rel="noreferrer"
                      >
                        HubSpot
                      </a>
                    ) : null}
                    <Link
                      className="underline hover:no-underline"
                      href={`/csm?workspace=${row.workspace_id}`}
                    >
                      Dashboard
                    </Link>
                  </div>
                </td>
                <td className="px-3 py-2 align-top text-fg">{row.csm_email}</td>
                <td className="px-3 py-2 align-top text-muted">
                  {row.csm_owner_change_date?.slice(0, 10) ?? "—"}
                </td>
                <td className="px-3 py-2 align-top text-center">
                  <SignalCell
                    missing={row.missing_status}
                    observedValue={row.observed_status}
                  />
                </td>
                <td className="px-3 py-2 align-top text-center">
                  <SignalCell
                    missing={row.missing_risk_level}
                    observedValue={row.observed_risk_level}
                  />
                </td>
                <td className="px-3 py-2 align-top text-center">
                  <SignalCell missing={row.missing_customer_folder} />
                </td>
                <td className="px-3 py-2 align-top text-center">
                  <SignalCell missing={row.missing_todos} />
                </td>
                <td className="px-3 py-2 align-top text-[12px] text-muted">
                  <RecoveryHint row={row} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SignalCell({
  missing,
  observedValue,
}: {
  missing: boolean;
  /** Optional value observed on the enum field — surfaced in the
   *  tooltip when present. Lets a reviewer see whether a downstream
   *  CSM changed Company Status from "Onboarding" to "Live" or
   *  moved Risk Level from "Light Green" to "Yellow" without having
   *  to open HubSpot for every row. */
  observedValue?: string | null;
}) {
  if (missing) {
    return (
      <span
        className="inline-block rounded-full px-2 py-0.5 text-[11px] font-medium bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
        title="empty"
      >
        empty
      </span>
    );
  }
  return (
    <span
      className="inline-block text-emerald-700 dark:text-emerald-300 text-sm"
      title={observedValue ? `set — "${observedValue}"` : "set"}
    >
      ✓
      {observedValue ? (
        <span className="ml-1 text-[11px] text-muted align-middle">
          {observedValue}
        </span>
      ) : null}
    </span>
  );
}

function RecoveryHint({
  row,
}: {
  row: Awaited<ReturnType<typeof runAssignAudit>>["affected"][number];
}) {
  const step1Failed = row.missing_status || row.missing_risk_level;
  const parts: React.ReactNode[] = [];
  if (step1Failed) {
    parts.push(
      <span key="step1">
        Step 1 (HubSpot owner/status/risk) didn&apos;t land — re-run{" "}
        <code className="font-mono">@bot assign</code> in Slack; safe now
        that #254 is deployed.
      </span>
    );
  }
  if (row.missing_todos && !step1Failed) {
    parts.push(
      <span key="todos">
        Open Lifecycle → Onboarding → find this card → click{" "}
        <em>Backfill checklist</em>
      </span>
    );
  }
  if (row.missing_customer_folder && !step1Failed) {
    parts.push(
      <span key="folder">
        Run{" "}
        <Link
          className="underline hover:no-underline"
          href="/settings/customer-folders"
        >
          /settings/customer-folders
        </Link>{" "}
        sweep and approve the row for this workspace
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {parts.map((p, i) => (
        <div key={i}>· {p}</div>
      ))}
    </div>
  );
}
