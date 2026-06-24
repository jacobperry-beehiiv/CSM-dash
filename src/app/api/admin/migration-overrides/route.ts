import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/auth/admin";
import {
  loadMigrationOverrides,
  saveMigrationOverrides,
} from "@/lib/data/migration-overrides";
import type { MigrationOverrides } from "@/lib/engines/migration-warmup/overrides";
import { DEFAULTS } from "@/lib/engines/migration-warmup/overrides";

export const dynamic = "force-dynamic";

/**
 * Admin-only knobs for the migration warm-up engine.
 *
 * GET  /api/admin/migration-overrides
 *   → { overrides, defaults }
 *
 * PUT  /api/admin/migration-overrides
 *   { open_rate_conservative_threshold?, approach_multipliers?, max_weeks? }
 *   → sanitized stored value (the store strips out-of-range values)
 *
 * Auth: signed-in super-admin only. Algorithm tuning is a team
 * decision, not a per-CSM preference.
 */

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!isAdmin(session.user.email)) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }
  const overrides = await loadMigrationOverrides();
  return NextResponse.json({ overrides, defaults: DEFAULTS });
}

export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!isAdmin(session.user.email)) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }
  let body: MigrationOverrides;
  try {
    body = (await req.json()) as MigrationOverrides;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const saved = await saveMigrationOverrides(body);
  return NextResponse.json({ overrides: saved, defaults: DEFAULTS });
}
