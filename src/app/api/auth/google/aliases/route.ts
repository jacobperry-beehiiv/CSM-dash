import { NextResponse } from "next/server";
import { getActiveEmail } from "@/lib/data/active-user";
import { getValidAccessTokenFor } from "@/lib/data/gmail-token";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/auth/google/aliases
 *
 * Lists every verified `sendAs` alias on the currently connected Gmail
 * account. Used by the template editor at /settings/templates so an
 * admin can pick a default sender per template (e.g. AM Past-Due
 * outreach → `am@beehiiv.com`, instead of the CSM's personal address).
 *
 * Backed by Gmail's `users.settings.sendAs.list` endpoint. Requires the
 * `gmail.settings.readonly` scope, which we add to the OAuth dance in
 * `src/app/api/auth/google/start/route.ts`. CSMs connected before the
 * scope was added see HTTP 403 here — the UI surfaces a "reconnect
 * Gmail to pick aliases" banner with a link to /api/auth/google/start.
 *
 * Cached in-process for 5 minutes per email. Beehiiv has ~50 CSMs and
 * each one's send-as list changes rarely; this keeps the template
 * settings page snappy without hammering Gmail on every save.
 */

export interface AliasRow {
  email: string;
  /** Display name configured for the alias, if any (e.g. "AM Team"). */
  name: string | null;
  /** True when this alias is the user's default outgoing identity. */
  is_default: boolean;
  /** True when this is the account's own primary address (`sendAsEmail
   *  === me`). Always present; can't be removed. */
  is_primary: boolean;
  /** "accepted" means Gmail verified the alias and the user can send
   *  from it. We filter the list to only verified entries before
   *  returning, so this is always true in practice — kept on the
   *  shape for future use. */
  verified: boolean;
}

interface SendAsResponse {
  sendAs?: Array<{
    sendAsEmail?: string;
    displayName?: string;
    isDefault?: boolean;
    isPrimary?: boolean;
    verificationStatus?: string;
  }>;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { expires: number; data: AliasRow[] }>();

export async function GET() {
  const activeEmail = await getActiveEmail();
  if (!activeEmail) {
    return NextResponse.json(
      {
        error:
          "No Gmail account connected for this browser. Visit /settings/gmail to connect.",
      },
      { status: 401 }
    );
  }

  const cached = cache.get(activeEmail);
  if (cached && cached.expires > Date.now()) {
    return NextResponse.json({
      active_email: activeEmail,
      aliases: cached.data,
      cached: true,
    });
  }

  let token: string;
  try {
    token = await getValidAccessTokenFor(activeEmail);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Token load failed" },
      { status: 401 }
    );
  }

  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs",
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    const body = await res.text();
    // 403 here almost always means the gmail.settings.readonly scope
    // wasn't granted (older OAuth grants predate the scope). Surface
    // a clear hint so the settings page can prompt a reconnect.
    if (res.status === 403) {
      return NextResponse.json(
        {
          error:
            "Gmail did not grant the gmail.settings.readonly scope. Reconnect Gmail at /settings/gmail to enable alias auto-discovery.",
          needs_reconsent: true,
        },
        { status: 403 }
      );
    }
    return NextResponse.json(
      {
        error: `Gmail API ${res.status}: ${body.slice(0, 300)}`,
      },
      { status: 502 }
    );
  }

  const raw = (await res.json()) as SendAsResponse;
  const aliases: AliasRow[] = (raw.sendAs ?? [])
    .filter(
      (a) =>
        a.sendAsEmail &&
        // Only surface verified aliases — sending from an unverified
        // alias either fails or gets silently rewritten by Gmail.
        (a.verificationStatus === "accepted" || a.isPrimary === true)
    )
    .map((a) => ({
      email: a.sendAsEmail!.toLowerCase(),
      name: a.displayName?.trim() || null,
      is_default: Boolean(a.isDefault),
      is_primary: Boolean(a.isPrimary),
      verified: true,
    }));

  cache.set(activeEmail, {
    expires: Date.now() + CACHE_TTL_MS,
    data: aliases,
  });

  return NextResponse.json({
    active_email: activeEmail,
    aliases,
    cached: false,
  });
}
