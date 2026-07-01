import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { SybillSyncControl } from "@/components/sybill-sync-control";

export const dynamic = "force-dynamic";

/**
 * /settings/sybill — manual "Sync action items from Sybill" button
 * + recent-run activity log.
 *
 * Gated by the `sybill-ingest` feature flag; non-allowlist users
 * land on the 404, indistinguishable from the page not existing
 * (same dark-launch posture as /settings/gmail-labels).
 */
export default async function SybillSettingsPage() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!(await isFeatureEnabledFor("sybill-ingest", email))) {
    notFound();
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg mb-1">
        Sybill action items
      </h1>
      <p className="text-sm text-muted mb-4">
        Sybill emails a recap after every call you host. Click sync to
        pull the &ldquo;Action items&rdquo; section from each recent recap and
        drop them on your personal to-do list. We don&rsquo;t touch your
        Gmail beyond reading those messages.
      </p>
      <SybillSyncControl />
    </div>
  );
}
