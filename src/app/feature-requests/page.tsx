import { FeatureRequestsPanel } from "@/components/feature-requests-panel";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Feature requests — CSM Mission Control",
};

/**
 * Feature request board page.
 *
 * Lightweight server shell — the panel is the whole interactive
 * surface (composer + list + voting + reorder). Kept thin because
 * the page-level work is just authentication via the layout's
 * existing chrome; everything else is client-side state against the
 * /api/feature-requests atomic-ops endpoint.
 */
export default function FeatureRequestsPage() {
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
