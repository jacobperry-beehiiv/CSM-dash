import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import {
  loadWinsConfigMeta,
  loadWinsConfigOverrides,
  saveWinsConfigOverrides,
} from "@/lib/data/wins-config";
import { DEFAULT_WINS_CONFIG } from "@/lib/data/wins-config-types";
import type { WinsConfig } from "@/lib/data/wins-config-types";

export const dynamic = "force-dynamic";

/**
 * GET /api/settings/wins
 *
 * Returns the current override blob + defaults so the settings page
 * can render "your value vs. shipped default" side by side. Gated
 * on the wins-opportunities feature flag — same allowlist as the
 * tab itself.
 */
export async function GET() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isFeatureEnabledFor("wins-opportunities", email))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const [overrides, meta] = await Promise.all([
    loadWinsConfigOverrides(),
    loadWinsConfigMeta(),
  ]);
  return NextResponse.json({
    defaults: DEFAULT_WINS_CONFIG,
    overrides,
    meta,
  });
}

/**
 * PUT /api/settings/wins
 *
 * Replace the override blob wholesale. Values matching the default
 * should be omitted client-side, but the server also strips any
 * override that matches the default (so a future default change
 * still propagates instead of getting pinned at the old value).
 *
 * Body: { overrides: DeepPartial<WinsConfig> }
 */
type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> };

export async function PUT(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isFeatureEnabledFor("wins-opportunities", email))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let payload: { overrides?: DeepPartial<WinsConfig> } = {};
  try {
    payload = (await req.json()) as { overrides?: DeepPartial<WinsConfig> };
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
  await saveWinsConfigOverrides(cleaned, email);
  return NextResponse.json({ ok: true, overrides: cleaned });
}

/** Remove any override field whose value equals the shipped default.
 *  Keeps the blob small and lets a default change roll forward
 *  automatically for anyone who hadn't customized that specific
 *  field. */
function stripMatchingDefaults(
  overrides: DeepPartial<WinsConfig>
): DeepPartial<WinsConfig> {
  const out: DeepPartial<WinsConfig> = {};
  for (const ruleKey of Object.keys(overrides) as Array<keyof WinsConfig>) {
    const rule = overrides[ruleKey];
    const defaults = DEFAULT_WINS_CONFIG[ruleKey];
    if (!rule || !defaults) continue;
    const kept: Record<string, number> = {};
    for (const [k, v] of Object.entries(rule)) {
      if (typeof v !== "number") continue;
      const defaultValue = (defaults as unknown as Record<string, number>)[k];
      if (defaultValue == null || v !== defaultValue) {
        kept[k] = v;
      }
    }
    if (Object.keys(kept).length > 0) {
      // Safe cast — kept only contains number-valued fields the
      // rule config exposes. Runtime shape matches Partial<RuleConfig>.
      out[ruleKey] = kept as (DeepPartial<WinsConfig>)[typeof ruleKey];
    }
  }
  return out;
}
