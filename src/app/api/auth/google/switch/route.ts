import { NextResponse } from "next/server";
import { setActiveEmail } from "@/lib/data/active-user";
import { loadTokenFor } from "@/lib/data/gmail-token";

export const dynamic = "force-dynamic";

interface PostBody {
  email: string;
}

/**
 * Switches the per-browser active CSM. Used by the /settings/gmail UI
 * when a browser already has multiple connected accounts on disk and the
 * CSM wants to flip between them without re-running OAuth.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as PostBody;
    const email = (body.email ?? "").toLowerCase();
    if (!email) {
      return NextResponse.json(
        { error: "email is required" },
        { status: 400 }
      );
    }
    const tok = await loadTokenFor(email);
    if (!tok) {
      return NextResponse.json(
        { error: `No connected Gmail token on file for ${email}.` },
        { status: 404 }
      );
    }
    await setActiveEmail(email);
    return NextResponse.json({ ok: true, email });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
