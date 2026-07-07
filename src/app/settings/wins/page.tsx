import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { WinsConfigEditor } from "@/components/wins-config-editor";
import {
  loadWinsConfigMeta,
  loadWinsConfigOverrides,
} from "@/lib/data/wins-config";
import { DEFAULT_WINS_CONFIG } from "@/lib/data/wins-config-types";

export const dynamic = "force-dynamic";

/**
 * /settings/wins — per-rule threshold editor for the Wins &
 * Opportunities detection engine. Every field has a shipped default;
 * saving stores only the fields that differ from the default, so a
 * future default change rolls forward for anyone who hadn't
 * customized that specific value.
 *
 * Gated by the wins-opportunities feature flag. Non-allowlist users
 * land on the 404, matching the sybill / gmail-labels pattern.
 */
export default async function WinsSettingsPage() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!(await isFeatureEnabledFor("wins-opportunities", email))) {
    notFound();
  }

  const [overrides, meta] = await Promise.all([
    loadWinsConfigOverrides(),
    loadWinsConfigMeta(),
  ]);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg mb-1">
        Wins &amp; Opportunities thresholds
      </h1>
      <p className="text-sm text-muted mb-4">
        Tune the four Phase 1 detection rules without a deploy. Fields
        left blank fall through to the shipped default; saving strips
        any override that matches the default so future defaults still
        propagate. Every change takes effect on the next detection run
        (daily 05:15 UTC cron, or click <em>Run detection now</em> on
        the Wins tab).
      </p>
      <WinsConfigEditor
        defaults={DEFAULT_WINS_CONFIG}
        initialOverrides={overrides}
        meta={meta}
      />
    </div>
  );
}
