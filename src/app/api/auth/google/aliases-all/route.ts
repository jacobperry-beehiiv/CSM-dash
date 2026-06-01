import { NextResponse } from "next/server";
import { listConnectedEmails } from "@/lib/data/gmail-token";
import {
  fetchAliasesFor,
  type AliasFetchResult,
  type AliasRow,
} from "@/lib/integrations/gmail-aliases";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/auth/google/aliases-all
 *
 * For every Gmail account connected to this dashboard, return the
 * list of verified send-as aliases on that account. Drives the
 * "which connection holds which alias" surface on /settings/gmail —
 * a CSM whose alias isn't showing up in the template editor needs
 * to know whether (a) the alias lives on a different connection
 * than the one they're actively signed in as, (b) their connection
 * predates the gmail.settings.readonly scope, or (c) Gmail simply
 * has no verified alias on the account.
 *
 * Per-account fetches share the in-process cache used by the
 * single-account /aliases endpoint, so repeated visits to
 * /settings/gmail in a session don't re-hit Gmail for every row.
 *
 * Errors on individual accounts don't fail the whole response —
 * each account row carries its own ok/error state so the UI can
 * render partial data + per-row hints.
 */

interface AccountAliasRow {
  email: string;
  aliases?: AliasRow[];
  error?: string;
  /** Set when the failure is the missing-scope case. */
  needs_reconsent?: boolean;
}

export async function GET() {
  let connected: string[];
  try {
    connected = await listConnectedEmails();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to list connections" },
      { status: 500 }
    );
  }

  // Fetch each account's aliases in parallel — the underlying helper
  // is cached, so on warm caches this is effectively free. On a cold
  // load we make N concurrent Gmail API calls; with ~30 connected
  // CSMs and a 100-req-per-100s Gmail quota, comfortably under cap.
  const results = await Promise.all(
    connected.map(
      async (email): Promise<{ email: string; result: AliasFetchResult }> => ({
        email,
        result: await fetchAliasesFor(email),
      })
    )
  );

  const accounts: AccountAliasRow[] = results.map(({ email, result }) => {
    if (result.kind === "ok") return { email, aliases: result.aliases };
    return {
      email,
      error: result.message,
      needs_reconsent: result.needs_reconsent ?? false,
    };
  });

  return NextResponse.json({ accounts });
}
