import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getRunState } from "@/lib/data/customer-signals-state";
import { findTokenOwner } from "@/lib/auth/api-tokens";

export const dynamic = "force-dynamic";

/**
 * GET /api/customer-signals/state?csm_email=…
 *   → 200 { csm_email, last_successful_run, last_run_id }
 *   → 404 if the CSM has never run (skill treats as "first run, use
 *     default 24h lookback")
 *
 * Auth mirrors the main customer-signals endpoint — Bearer token OR
 * an authenticated NextAuth session.
 */

async function authorize(req: Request): Promise<
  { ok: true } | { ok: false; status: number; message: string }
> {
  const auth_header = req.headers.get("authorization");
  if (auth_header?.startsWith("Bearer ")) {
    const candidate = auth_header.slice(7).trim();
    // Per-user token first, then the legacy shared key.
    const owner = await findTokenOwner(candidate);
    if (owner) return { ok: true };
    const sharedKey =
      process.env.SIGNAL_API_KEY ?? process.env.CUSTOMER_SIGNALS_API_TOKEN;
    if (sharedKey && candidate === sharedKey) return { ok: true };
    if (!sharedKey) {
      return {
        ok: false,
        status: 401,
        message:
          "Unknown Bearer token. Mint one at /settings/api-tokens or set SIGNAL_API_KEY for the legacy shared-key flow.",
      };
    }
    return { ok: false, status: 401, message: "invalid bearer token" };
  }
  const session = await auth();
  if (!session?.user?.email) {
    return {
      ok: false,
      status: 401,
      message:
        "Not signed in. Sign in via /login, or pass Authorization: Bearer <token> (mint one at /settings/api-tokens).",
    };
  }
  return { ok: true };
}

export async function GET(req: Request) {
  const a = await authorize(req);
  if (!a.ok) return NextResponse.json({ error: a.message }, { status: a.status });

  const url = new URL(req.url);
  const csmEmail = url.searchParams.get("csm_email");
  if (!csmEmail) {
    return NextResponse.json(
      { error: "csm_email query param is required" },
      { status: 400 }
    );
  }
  try {
    const state = await getRunState(csmEmail);
    if (!state) {
      return NextResponse.json(
        { error: "no run state for this csm_email yet" },
        { status: 404 }
      );
    }
    return NextResponse.json(state);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
