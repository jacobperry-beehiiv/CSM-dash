import { NextResponse } from "next/server";
import { getActiveEmail } from "@/lib/data/active-user";
import { fetchAliasesFor } from "@/lib/integrations/gmail-aliases";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/auth/google/aliases
 *
 * Lists every verified `sendAs` alias on the currently-active Gmail
 * connection (whichever account this browser's cookie points at).
 * Used by the template editor's "Send as" picker.
 *
 * The shared helper in `src/lib/integrations/gmail-aliases.ts` does
 * the actual Gmail-API call + 5-minute caching, so this route stays
 * a thin authn wrapper that injects the active email.
 *
 * Sibling endpoint `/api/auth/google/aliases-all` returns aliases for
 * EVERY connected account at once — used by /settings/gmail to help
 * a CSM see which alias lives on which connection.
 */

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

  const result = await fetchAliasesFor(activeEmail);
  if (result.kind === "error") {
    return NextResponse.json(
      {
        error: result.message,
        needs_reconsent: result.needs_reconsent ?? false,
      },
      { status: result.needs_reconsent ? 403 : 502 }
    );
  }
  return NextResponse.json({
    active_email: activeEmail,
    aliases: result.aliases,
  });
}
