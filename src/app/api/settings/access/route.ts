import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/auth/admin";
import { invalidateCsmTeamCache } from "@/lib/auth/csm-team";
import { loadSettings, saveSettings } from "@/lib/data/settings";

export const dynamic = "force-dynamic";

/**
 * GET  /api/settings/access  — returns the current access
 *   allowlist. Admin-only.
 * PUT  /api/settings/access  — replaces the allowlist with a
 *   validated + normalized version (lowercased, trimmed, deduped,
 *   loose-email-shape checked). Admin-only. Busts the CSM-team
 *   cache on save so a just-added member doesn't have to wait for
 *   the 5-min TTL.
 *
 * Body shape (PUT): `{ extra_csm_emails: string[] }`.
 */

interface PutBody {
  extra_csm_emails?: unknown;
}

// Loose email guard — enough to catch typos ("richard.evans" with
// no @). We don't hand-parse RFC 5322; if a bad email lands in the
// list the auth check just silently never matches it and the user
// stays gated.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!isAdmin(email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const settings = await loadSettings();
  return NextResponse.json({
    extra_csm_emails: settings.access?.extra_csm_emails ?? [],
  });
}

export async function PUT(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (!isAdmin(email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const raw = Array.isArray(body.extra_csm_emails) ? body.extra_csm_emails : [];
  // Normalize: string-only, trimmed, lowercased, non-empty,
  // loose-email-checked, deduped, sorted. The merge() step will do
  // the same normalization but we mirror it here so the response
  // reflects what actually got persisted (including any dropped
  // rows) instead of an optimistic echo.
  const cleaned = Array.from(
    new Set(
      raw
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim().toLowerCase())
        .filter((v) => v.length > 0 && EMAIL_RE.test(v))
    )
  ).sort();

  const current = await loadSettings();
  const next = await saveSettings({
    ...current,
    access: {
      ...(current.access ?? {}),
      extra_csm_emails: cleaned,
    },
  });

  // Bust every cached CSM-team verdict — cheaper than reasoning
  // about which specific emails were added/removed, and the cache
  // rebuilds itself on the next check per email.
  invalidateCsmTeamCache();

  return NextResponse.json({
    ok: true,
    extra_csm_emails: next.access?.extra_csm_emails ?? [],
    dropped: raw.length - cleaned.length,
  });
}
