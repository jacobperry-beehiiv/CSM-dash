import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { FeatureRequestsPanel } from "@/components/feature-requests-panel";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Feature requests — CSM Mission Control",
};

/**
 * Feature request board page.
 *
 * Lightweight server shell — the panel is the whole interactive
 * surface (composer + list + voting + reorder). Everything else is
 * client-side state against the /api/feature-requests atomic-ops
 * endpoint.
 *
 * Flag-gated behind `feature-request-board`. `notFound()` rather than
 * a redirect so a direct link reads as "no such page" instead of
 * advertising that something exists here — matching how the other
 * dark-shipped surfaces behave. The API route carries the same gate,
 * because hiding the page doesn't hide the endpoint.
 */
export default async function FeatureRequestsPage() {
  const session = await auth();
  if (!(await isFeatureEnabledFor("feature-request-board", session?.user?.email))) {
    notFound();
  }
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold text-fg tracking-tight">
          Feature requests
        </h1>
        <p className="text-sm text-muted mt-1">
          What should we build next on Mission Control? Submit ideas, vote
          on the ones you want most, and drag-rank the queue.
        </p>
      </div>
      <FeatureRequestsPanel />
    </div>
  );
}
