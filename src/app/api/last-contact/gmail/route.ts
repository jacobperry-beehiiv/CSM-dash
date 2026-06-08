import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getActiveEmail } from "@/lib/data/active-user";
import {
  GmailReadScopeError,
  lastEmailWithBatch,
  lastEmailWithCached,
} from "@/lib/integrations/gmail-read";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * "Last contacted via Gmail" lookup.
 *
 *   GET  /api/last-contact/gmail?email=foo@acme.com  → single
 *   POST /api/last-contact/gmail                     → batch
 *        body: { emails: string[], forceFresh?: boolean }
 *
 * Auth: NextAuth session (dashboard pages call this) + must have an
 * active Gmail connection (csm_active_email cookie set on the
 * Gmail-OAuth callback). The Gmail query uses the active CSM's token,
 * so the response only reflects what THAT CSM has emailed / been
 * emailed by.
 *
 * Three failure modes the UI should distinguish:
 *
 *   401 → no NextAuth session OR no active Gmail connection.
 *         Body: { error, no_active_gmail: true } when it's the
 *         second case so the UI can point users to /settings/gmail.
 *   403 → Gmail token doesn't have gmail.readonly scope.
 *         Body: { error, needs_reconsent: true } so the UI can show
 *         the "Reconnect Gmail to enable Gmail-source contact dates"
 *         banner with a /settings/gmail link.
 *   200 → results map (POST) or single result (GET).
 */

interface BatchBody {
  emails?: string[];
  forceFresh?: boolean;
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
  const forceFresh = url.searchParams.get("forceFresh") === "1";
  if (!target) {
    return NextResponse.json(
      { error: "Missing required query param: email" },
      { status: 400 }
    );
  }
  try {
    const entry = await lastEmailWithCached(activeEmail, target, {
      forceFresh,
    });
    return NextResponse.json({
      date: entry.date,
      subject: entry.subject,
      from: entry.from,
      source: "gmail",
      fetched_at: entry.fetched_at,
      cached: entry.cached,
    });
  } catch (e) {
    if (e instanceof GmailReadScopeError) {
      return NextResponse.json(
        {
          error:
            "Gmail token doesn't have the gmail.readonly scope yet. Reconnect at /settings/gmail.",
          needs_reconsent: true,
        },
        { status: 403 }
      );
    }
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[last-contact/gmail GET]", { activeEmail, target, msg });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
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
  let body: BatchBody;
  try {
    body = (await req.json()) as BatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const emails = Array.isArray(body.emails) ? body.emails : [];
  if (emails.length === 0) {
    return NextResponse.json(
      { error: "Body must include a non-empty `emails` array" },
      { status: 400 }
    );
  }
  // Soft cap so a runaway client (or a customer book with thousands
  // of unique owner emails) doesn't burn through Gmail quota in one
  // request. The customer book is small in practice; 500 is generous.
  const MAX_PER_BATCH = 500;
  const truncated = emails.slice(0, MAX_PER_BATCH);

  try {
    console.log("[last-contact/gmail POST]", {
      activeEmail,
      requested: emails.length,
      processed: truncated.length,
    });
    const results = await lastEmailWithBatch(activeEmail, truncated);
    return NextResponse.json({
      results,
      count: Object.keys(results).length,
      truncated: emails.length > truncated.length,
    });
  } catch (e) {
    if (e instanceof GmailReadScopeError) {
      return NextResponse.json(
        {
          error:
            "Gmail token doesn't have the gmail.readonly scope yet. Reconnect at /settings/gmail.",
          needs_reconsent: true,
        },
        { status: 403 }
      );
    }
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[last-contact/gmail POST]", { activeEmail, msg });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
