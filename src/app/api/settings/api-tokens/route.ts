import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { createToken, listTokensForUser } from "@/lib/auth/api-tokens";

export const dynamic = "force-dynamic";

/**
 * GET  /api/settings/api-tokens
 *   → 200 with the signed-in user's tokens (no plaintext, no hash).
 *
 * POST /api/settings/api-tokens   { label }
 *   → 201 with `{ token, plaintext }`. Plaintext is returned ONCE —
 *     the UI shows it to the user with a copy button and then we can
 *     never recover it server-side.
 *
 * Session-only (no Bearer path). Token management belongs to a
 * logged-in human, not to a script holding another token.
 */

async function requireSession(): Promise<
  { ok: true; email: string } | { ok: false; res: NextResponse }
> {
  const session = await auth();
  if (!session?.user?.email) {
    return {
      ok: false,
      res: NextResponse.json(
        { error: "Not signed in. Sign in via /login first." },
        { status: 401 }
      ),
    };
  }
  return { ok: true, email: session.user.email };
}

export async function GET() {
  const a = await requireSession();
  if (!a.ok) return a.res;
  try {
    const tokens = await listTokensForUser(a.email);
    return NextResponse.json({ tokens });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const a = await requireSession();
  if (!a.ok) return a.res;

  let body: { label?: string };
  try {
    body = (await req.json()) as { label?: string };
  } catch {
    return NextResponse.json(
      { error: "Body must be valid JSON" },
      { status: 400 }
    );
  }
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) {
    return NextResponse.json({ error: "label is required" }, { status: 400 });
  }
  if (label.length > 80) {
    return NextResponse.json(
      { error: "label must be 80 characters or fewer" },
      { status: 400 }
    );
  }
  try {
    const { plaintext, token } = await createToken(a.email, label);
    // Strip the hash before returning — same shape the GET endpoint
    // emits for consistency.
    const { hash: _hash, ...safe } = token;
    return NextResponse.json({ token: safe, plaintext }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
