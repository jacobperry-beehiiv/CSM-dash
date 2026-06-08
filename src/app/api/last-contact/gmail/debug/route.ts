import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getActiveEmail } from "@/lib/data/active-user";
import { getValidAccessTokenFor } from "@/lib/data/gmail-token";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Diagnostic endpoint for "why does Last contacted show <date> for
 * this customer?" Returns the top N matches Gmail returns for the
 * same query the production lookup uses, plus the resolved Subject +
 * From + Date for each. Lets a CSM see what's actually matching when
 * the displayed date looks wrong (drafts, calendar invites, system
 * notifications that slipped past the filters, etc.).
 *
 *   GET /api/last-contact/gmail/debug?email=foo@acme.com[&limit=5]
 *
 * Returns 200 with { query, matches: [{ id, date, subject, from }] }.
 * 401 if no session / no active Gmail, 403 if scope missing.
 *
 * Intentionally NOT cached — every call hits Gmail live so the value
 * reflects what's in the inbox right now.
 */

const SYSTEM_SENDER_EXCLUSIONS = [
  "mailer-daemon",
  "postmaster",
  "noreply",
  "no-reply",
  "notifications",
  "calendar-notification@google.com",
  "notifications@hubspot.com",
  "notifications@github.com",
  "noreply@intercom.io",
  "notify@intercom.io",
  "notifications@zapier.com",
];

function buildQuery(targetEmail: string): string {
  const safe = targetEmail.trim().toLowerCase().replace(/["\\]/g, "");
  return (
    `(from:${safe} OR to:${safe})` +
    ` -in:drafts -in:chats -in:scheduled` +
    ` -category:promotions -category:social -category:updates -category:forums` +
    SYSTEM_SENDER_EXCLUSIONS.map((s) => ` -from:${s}`).join("")
  );
}

interface MatchDetail {
  id: string;
  date: string | null;
  subject: string | null;
  from: string | null;
  to: string | null;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  const activeEmail = await getActiveEmail();
  if (!activeEmail) {
    return NextResponse.json(
      {
        error:
          "No Gmail account connected for this browser. Visit /settings/gmail.",
        no_active_gmail: true,
      },
      { status: 401 }
    );
  }
  const url = new URL(req.url);
  const target = (url.searchParams.get("email") ?? "").trim();
  const limitRaw = Number(url.searchParams.get("limit") ?? "5");
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 20
      ? Math.floor(limitRaw)
      : 5;
  if (!target) {
    return NextResponse.json(
      { error: "Missing required query param: email" },
      { status: 400 }
    );
  }
  const token = await getValidAccessTokenFor(activeEmail);
  if (!token) {
    return NextResponse.json(
      {
        error: `No valid Gmail token for ${activeEmail}. Reconnect at /settings/gmail.`,
        needs_reconsent: true,
      },
      { status: 403 }
    );
  }

  const q = buildQuery(target);
  const listUrl =
    `https://gmail.googleapis.com/gmail/v1/users/me/messages` +
    `?q=${encodeURIComponent(q)}&maxResults=${limit}`;
  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!listRes.ok) {
    const body = await listRes.text().catch(() => "");
    return NextResponse.json(
      { error: `Gmail messages.list failed (${listRes.status}): ${body.slice(0, 200)}` },
      { status: 500 }
    );
  }
  const list = (await listRes.json()) as {
    messages?: Array<{ id?: string }>;
  };
  const ids = (list.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string");

  // Fetch each message's metadata in parallel — 5 is well under any
  // Gmail concurrency limit. format=metadata keeps payloads tiny.
  const matches: MatchDetail[] = await Promise.all(
    ids.map(async (id): Promise<MatchDetail> => {
      const params = new URLSearchParams({ format: "metadata" });
      params.append("metadataHeaders", "Subject");
      params.append("metadataHeaders", "From");
      params.append("metadataHeaders", "To");
      const getUrl =
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/` +
        encodeURIComponent(id) +
        `?${params.toString()}`;
      const r = await fetch(getUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        return { id, date: null, subject: null, from: null, to: null };
      }
      const msg = (await r.json()) as {
        internalDate?: string;
        payload?: { headers?: Array<{ name?: string; value?: string }> };
      };
      let subject: string | null = null;
      let from: string | null = null;
      let to: string | null = null;
      for (const h of msg.payload?.headers ?? []) {
        const name = (h.name ?? "").toLowerCase();
        if (name === "subject" && typeof h.value === "string") subject = h.value;
        else if (name === "from" && typeof h.value === "string") from = h.value;
        else if (name === "to" && typeof h.value === "string") to = h.value;
      }
      const ms = Number(msg.internalDate ?? NaN);
      const date = Number.isFinite(ms) ? new Date(ms).toISOString() : null;
      return { id, date, subject, from, to };
    })
  );

  return NextResponse.json({
    target,
    activeEmail,
    query: q,
    count: matches.length,
    matches,
  });
}
