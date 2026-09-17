import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { loadSettings, saveSettings } from "@/lib/data/settings";
import {
  PLAYBOOK_STEPS,
  resolveLifecycleStepStages,
} from "@/lib/lifecycle/step-stage-config";

export const dynamic = "force-dynamic";

/**
 * GET /api/settings/lifecycle-step-stages — the current, fully
 *   resolved step->column map (defaults + any admin overrides).
 * PUT /api/settings/lifecycle-step-stages — replaces the map with a
 *   validated one. Open to any signed-in CSM the lifecycle-board flag
 *   covers (not admin-gated beyond that) — same access level as the
 *   rest of /settings/slack was for the section this replaces.
 *
 * Body shape (PUT): `{ step_stages: Record<string, string> }`.
 *
 * Both gated on the lifecycle-board feature flag — same allowlist as
 * the settings page and the /csm?tab=lifecycle tab itself.
 */

const VALID_STEP_KEYS = new Set(PLAYBOOK_STEPS.map((s) => s.step_key));

export async function GET() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!(await isFeatureEnabledFor("lifecycle-board", email))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const settings = await loadSettings();
  return NextResponse.json({
    step_stages: resolveLifecycleStepStages(settings.lifecycle_step_stages),
  });
}

export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!(await isFeatureEnabledFor("lifecycle-board", session.user.email))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { step_stages?: unknown };
  try {
    body = (await req.json()) as { step_stages?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const raw =
    body.step_stages && typeof body.step_stages === "object"
      ? (body.step_stages as Record<string, unknown>)
      : {};

  // Drop anything that isn't a real step_key or whose value isn't a
  // non-empty string — a stale/typo'd entry just silently falls back
  // to the step's default via resolveLifecycleStepStages, same as an
  // omitted one.
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!VALID_STEP_KEYS.has(key)) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    cleaned[key] = value.trim();
  }

  try {
    const current = await loadSettings();
    const next = await saveSettings({
      ...current,
      lifecycle_step_stages: cleaned,
    });
    return NextResponse.json({
      step_stages: resolveLifecycleStepStages(next.lifecycle_step_stages),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
