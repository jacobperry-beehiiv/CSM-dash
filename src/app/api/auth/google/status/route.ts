import { NextResponse } from "next/server";
import {
  deleteToken,
  listConnectedEmails,
  loadTokenFor,
} from "@/lib/data/gmail-token";
import { clearActiveEmail, getActiveEmail } from "@/lib/data/active-user";

export const dynamic = "force-dynamic";

export async function GET() {
  const activeEmail = await getActiveEmail();
  const tok = activeEmail ? await loadTokenFor(activeEmail) : null;
  const all = await listConnectedEmails();
  return NextResponse.json({
    connected: !!tok,
    email: tok?.email ?? null,
    scope: tok?.scope ?? null,
    /** Every account known to the dashboard, so the UI can offer a switcher
     *  if more than one CSM has connected from the same browser. */
    connected_emails: all,
  });
}

export async function DELETE(req: Request) {
  // ?everywhere=1 wipes the per-user token from disk; default just clears the
  // browser cookie so the next CSM can OAuth fresh.
  const url = new URL(req.url);
  const everywhere = url.searchParams.get("everywhere") === "1";
  const activeEmail = await getActiveEmail();
  if (everywhere && activeEmail) {
    await deleteToken(activeEmail);
  }
  await clearActiveEmail();
  return NextResponse.json({ ok: true });
}
