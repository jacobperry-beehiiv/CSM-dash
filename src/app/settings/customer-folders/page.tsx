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
      /** CSM handle from the customer book, in the underscore form
       *  q10600 exposes it ("Jacob_Perry"). Threaded into the review
       *  component so it can filter the queue to only rows whose
       *  candidate matches sit in the viewer's book by default. */
      customer_success_manager: c.customer_success_manager ?? null,
    }));

  // Viewer's CSM handle — resolved from the customer book by matching
  // the signed-in email against `customer_success_manager_email`.
  // When the viewer is an admin who isn't a CSM (e.g. Jacob viewing
  // for others), this is null and the scope toggle defaults to "show
  // all" since there's no book to scope to.
  const viewerCsm =
    (email
      ? customers.find(
          (c) =>
            (c.customer_success_manager_email ?? "").toLowerCase() ===
            email.toLowerCase()
        )?.customer_success_manager ?? null
      : null);

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
      <CustomerFoldersReview workspaces={workspaceIndex} viewerCsm={viewerCsm} />
    </div>
  );
}
