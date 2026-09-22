import Link from "next/link";
import { runAssignAudit, type AssignAuditFingerprint } from "@/lib/engines/assign-audit";
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
 * endpoint). This page enumerates every assigned account whose two
 * downstream signals — CSM's `slack_assign` todo batch, HubSpot's
 * `customer_folder` property — don't both look landed, so a CSM can
 * decide per-row which recovery path applies:
 *
 *   • Missing todos            → /api/lifecycle/backfill-onboarding
 *                                (button on the Lifecycle board's
 *                                Onboarding sub-tab when the card's
 *                                checklist is empty)
 *   • Missing customer_folder  → /settings/customer-folders sweep
 *                                (fuzzy-matches orphaned Drive
 *                                folders back to HubSpot)
 *   • Missing both             → re-run @bot assign in Slack (safe
 *                                now, post-#254 — the dedup lock on
 *                                the todo batch keeps it idempotent)
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
          references the customer book against per-CSM slack_assign
          todo batches and HubSpot&apos;s <code className="font-mono">customer_folder</code>{" "}
          property. Read-only — recovery actions link out to the
          existing tools.
        </p>
      </header>

      <SummaryCard report={report} />

      {report.affected.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-6 text-sm text-muted">
          Nothing to backfill — every assignment in the affected window has both
          a matching todo batch and a linked Drive folder.
        </div>
      ) : (
        <AuditTable rows={report.affected} />
      )}

      <footer className="text-xs text-muted">
        Ran at {new Date(report.ran_at).toLocaleString()} · scanned{" "}
        {report.scanned_customers} customers across {report.scanned_csms} CSMs
      </footer>
    </div>
  );
}

function SummaryCard({
  report,
}: {
  report: Awaited<ReturnType<typeof runAssignAudit>>;
}) {
  const cells: Array<{
    label: string;
    count: number;
    hint: string;
    fingerprint: AssignAuditFingerprint | "total";
  }> = [
    {
      label: "Neither todos nor Drive folder",
      count: report.totals.no_todos_no_folder,
      hint: "Timed out at or before step 3 — HubSpot took but nothing after.",
      fingerprint: "no_todos_no_folder",
    },
    {
      label: "Todos present, Drive missing",
      count: report.totals.todos_present_folder_missing,
      hint: "Timed out at step 4/4b/5 — Drive folder never linked in HubSpot.",
      fingerprint: "todos_present_folder_missing",
    },
    {
      label: "Drive present, todos missing",
      count: report.totals.folder_present_todos_missing,
      hint: "Atypical — usually a manual customer_folder edit without @bot.",
      fingerprint: "folder_present_todos_missing",
    },
    {
      label: "Total affected",
      count: report.affected.length,
      hint: "Sum of the three buckets above.",
      fingerprint: "total",
    },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cells.map((cell) => (
        <div
          key={cell.fingerprint}
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

const FINGERPRINT_LABEL: Record<AssignAuditFingerprint, string> = {
  no_todos_no_folder: "Neither",
  todos_present_folder_missing: "Todos only",
  folder_present_todos_missing: "Drive only",
};

const FINGERPRINT_STYLE: Record<AssignAuditFingerprint, string> = {
  no_todos_no_folder:
    "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  todos_present_folder_missing:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  folder_present_todos_missing:
    "bg-slate-100 text-slate-700 dark:bg-slate-800/50 dark:text-slate-300",
};

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
            <th className="px-3 py-2 font-medium">Missing</th>
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
                <td className="px-3 py-2 align-top">
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      FINGERPRINT_STYLE[row.fingerprint]
                    }`}
                    title={row.fingerprint.replace(/_/g, " ")}
                  >
                    {FINGERPRINT_LABEL[row.fingerprint]}
                  </span>
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

function RecoveryHint({
  row,
}: {
  row: Awaited<ReturnType<typeof runAssignAudit>>["affected"][number];
}) {
  const parts: React.ReactNode[] = [];
  if (row.missing_todos) {
    parts.push(
      <span key="todos">
        Open Lifecycle → Onboarding → find this card → click{" "}
        <em>Backfill checklist</em>
      </span>
    );
  }
  if (row.missing_customer_folder) {
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
