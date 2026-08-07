import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import {
  loadUpgradeAnalysisConfigMeta,
  loadUpgradeAnalysisConfigOverrides,
  saveUpgradeAnalysisConfigOverrides,
} from "@/lib/data/upgrade-analysis-config";
import {
  DEFAULT_UPGRADE_ANALYSIS_CONFIG,
  type UpgradeAnalysisConfig,
  type UpgradeAnalysisConfigOverrides,
} from "@/lib/data/upgrade-analysis-config-types";

export const dynamic = "force-dynamic";

/**
 * GET /api/upgrade-analysis/config
 *
 * Returns the current override blob + defaults so the settings page
 * (or a curl) can render "your value vs. shipped default" side by side.
 * Gated on the upgrade-analysis feature flag.
 */
export async function GET() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isFeatureEnabledFor("upgrade-analysis", email))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const [overrides, meta] = await Promise.all([
    loadUpgradeAnalysisConfigOverrides(),
    loadUpgradeAnalysisConfigMeta(),
  ]);
  return NextResponse.json({
    defaults: DEFAULT_UPGRADE_ANALYSIS_CONFIG,
    overrides,
    meta,
  });
}

/**
 * PUT /api/upgrade-analysis/config
 *
 * Body: { overrides: DeepPartial<UpgradeAnalysisConfig> }
 *
 * Replaces the override blob wholesale. Any value that matches the
 * shipped default is stripped so a future default change still
 * propagates instead of getting pinned at the old value.
 */
export async function PUT(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isFeatureEnabledFor("upgrade-analysis", email))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let payload: { overrides?: UpgradeAnalysisConfigOverrides } = {};
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!payload.overrides || typeof payload.overrides !== "object") {
    return NextResponse.json(
      { error: "Missing overrides object" },
      { status: 400 }
    );
  }

  const cleaned = stripMatchingDefaults(payload.overrides);
  await saveUpgradeAnalysisConfigOverrides(cleaned, email);
  return NextResponse.json({ ok: true, overrides: cleaned });
}

/** Remove override fields whose value equals the shipped default. */
function stripMatchingDefaults(
  overrides: UpgradeAnalysisConfigOverrides
): UpgradeAnalysisConfigOverrides {
  const out: UpgradeAnalysisConfigOverrides = {};
  for (const groupKey of Object.keys(overrides) as Array<
    keyof UpgradeAnalysisConfig
  >) {
    const group = overrides[groupKey];
    const defaults = DEFAULT_UPGRADE_ANALYSIS_CONFIG[groupKey];
    if (!group || !defaults) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kept: Record<string, any> = {};
    for (const [k, v] of Object.entries(group)) {
      const defaultValue = (defaults as unknown as Record<string, unknown>)[k];
      // Deep-compare via JSON — the escalation.slack_escalation_terms
      // field is a string[] so we can't rely on identity. Cheap
      // enough at this scale.
      if (JSON.stringify(defaultValue) !== JSON.stringify(v)) {
        kept[k] = v;
      }
    }
    if (Object.keys(kept).length > 0) {
      // Runtime shape matches Partial<GroupConfig>.
      out[groupKey] = kept as UpgradeAnalysisConfigOverrides[typeof groupKey];
    }
  }
  return out;
}
