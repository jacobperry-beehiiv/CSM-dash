import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { loadCustomers } from "@/lib/data/load-customers";
import { CustomerFoldersReview } from "@/components/customer-folders-review";

export const dynamic = "force-dynamic";

/**
 * /settings/customer-folders — admin review + backfill tool for the
 * HubSpot `customer_folder` property, powered by a scan of the
 * shared Drive parent folder.
 *
 * Gated by the `customer-folders-sweep` feature flag; non-allowlist
 * users land on 404 (dark-launch posture matching /settings/sybill
 * and /settings/gmail-labels).
 *
 * We fetch the customer book server-side so the review table can
 * label matches with human-readable names without a client-side
 * round-trip per row. Sensitive fields aren't sent — just what the
 * table needs.
 */
export default async function CustomerFoldersSettingsPage() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!(await isFeatureEnabledFor("customer-folders-sweep", email))) {
    notFound();
  }

  const customers = await loadCustomers();
  const workspaceIndex = customers
    .filter((c): c is typeof c & { workspace_id: string } =>
      Boolean(c.workspace_id)
    )
    .map((c) => ({
      workspace_id: c.workspace_id,
      workspace_name: c.workspace_name ?? null,
      company_name: c.company_name ?? null,
      has_folder: Boolean(
        typeof c.property_customer_folder === "string" &&
          c.property_customer_folder.trim().length > 0
      ),
    }));

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg mb-1">
        Customer folders sweep
      </h1>
      <p className="text-sm text-muted mb-4">
        Scans the shared &ldquo;Customer Folders&rdquo; Drive parent, fuzzy-matches
        each child folder to a customer in the book, and (after your
        review) writes the folder URL into HubSpot&rsquo;s
        {" "}<code className="font-mono text-xs">customer_folder</code>{" "}
        property. Existing values are always preserved &mdash; the sweep only
        backfills BLANK fields.
      </p>
      <CustomerFoldersReview workspaces={workspaceIndex} />
    </div>
  );
}
