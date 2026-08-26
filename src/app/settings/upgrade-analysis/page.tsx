import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { UpgradeAnalysisConfigEditor } from "@/components/upgrade-analysis-config-editor";
import {
  loadUpgradeAnalysisConfigMeta,
  loadUpgradeAnalysisConfigOverrides,
} from "@/lib/data/upgrade-analysis-config";
import { DEFAULT_UPGRADE_ANALYSIS_CONFIG } from "@/lib/data/upgrade-analysis-config-types";

export const dynamic = "force-dynamic";

/**
 * /settings/upgrade-analysis — threshold registry editor for the D&C
 * Upgrade Analysis scorecard. One card per group (complaints,
 * deferrals, engagement, volume, escalation); every field falls
 * through to the shipped default when the input is empty. Saving
 * strips any override matching the default so future default
 * changes propagate.
 *
 * Gated by the upgrade-analysis feature flag. Non-allowlist users
 * land on the 404, matching the wins / sybill / gmail-labels pattern.
 */
export default async function UpgradeAnalysisSettingsPage() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!(await isFeatureEnabledFor("upgrade-analysis", email))) {
    notFound();
  }

  const [overrides, meta] = await Promise.all([
    loadUpgradeAnalysisConfigOverrides(),
    loadUpgradeAnalysisConfigMeta(),
  ]);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg mb-1">
        D&amp;C Upgrade Analysis thresholds
      </h1>
      <p className="text-sm text-muted mb-4">
        Tune the scorecard&apos;s bands without a deploy. Fields left blank
        fall through to the shipped default; saving strips any override
        that matches the default so future defaults still propagate.
        Changes take effect on the next scan run — cached reports keep
        their prior verdict until they&apos;re re-scanned.
      </p>
      <UpgradeAnalysisConfigEditor
        defaults={DEFAULT_UPGRADE_ANALYSIS_CONFIG}
        initialOverrides={overrides}
        meta={meta}
      />
    </div>
  );
}
