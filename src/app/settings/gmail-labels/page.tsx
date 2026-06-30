import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import {
  filterCustomers,
  findCsmHandleForViewer,
  loadCustomers,
} from "@/lib/data/load-customers";
import { GmailLabelsManager } from "@/components/gmail-labels-manager";

export const dynamic = "force-dynamic";

/**
 * /settings/gmail-labels — per-customer Gmail label review + override.
 *
 * Gated by the `gmail-draft-labels` feature flag. Non-allowlist users
 * land on a 404 (indistinguishable from "page doesn't exist"), keeping
 * the dark-launch posture intact.
 *
 * The page is a server component that fetches the viewer's book, then
 * hands off to the client island `GmailLabelsManager` for the live
 * editor + scan controls. We do the customer fetch server-side so the
 * page paints with content immediately; the mapping + label list are
 * loaded client-side because they depend on Gmail (and we want the
 * "Re-consent required" banner to be a soft state, not a 500).
 */
export default async function GmailLabelsSettingsPage() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!(await isFeatureEnabledFor("gmail-draft-labels", email))) {
    notFound();
  }
  const viewer = email as string;

  const all = await loadCustomers();
  const csmHandle = findCsmHandleForViewer(all, viewer);
  const book = filterCustomers(all, { csm: csmHandle });
  const eligible = book
    .filter((c): c is typeof c & { workspace_id: string } => Boolean(c.workspace_id))
    .map((c) => ({
      workspace_id: c.workspace_id,
      workspace_name: c.workspace_name ?? null,
      company_name: c.company_name ?? null,
      owner_email: c.owner_email ?? null,
    }))
    .sort((a, b) => {
      const an = (a.company_name ?? a.workspace_name ?? "").toLowerCase();
      const bn = (b.company_name ?? b.workspace_name ?? "").toLowerCase();
      return an.localeCompare(bn);
    });

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg mb-1">
        Gmail customer labels
      </h1>
      <p className="text-sm text-muted mb-4">
        We don&rsquo;t create new labels — we just match each customer in your
        book to the label you already use in Gmail. Drafts the dashboard
        generates land under the right label automatically. Manual overrides
        pin past auto-scans.
      </p>
      <GmailLabelsManager customers={eligible} />
    </div>
  );
}
