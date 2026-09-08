import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";
import { saveManualMapping } from "@/lib/data/enterprise-requests";

export const dynamic = "force-dynamic";

/**
 * POST /api/enterprise-requests/unmatched/apply
 *
 * Body: `{ linear_customer_id, workspace_id }` where workspace_id is
 * either a real UUID (approve) or the sentinel `"__skipped"` (drop
 * from the unmatched queue on next sync).
 *
 * Writes to the manual-map KV blob. The sync engine's matcher reads
 * that blob FIRST — before the three-strike externalIds/domains
 * fall-through — so an approval is applied on the very next
 * enterprise-requests-sync run without needing a Linear-side edit.
 *
 * Session-auth + flag-gated. Non-allowlist users get 403.
 */

interface Body {
  linear_customer_id?: string;
  workspace_id?: string;
}

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (!(await isFeatureEnabledFor("enterprise-requests", email))) {
    return NextResponse.json(
      { error: "Enterprise Request Loop is not enabled for you." },
      { status: 403 }
    );
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const linearCustomerId = (body.linear_customer_id ?? "").trim();
  const workspaceId = (body.workspace_id ?? "").trim();
  if (!linearCustomerId || !workspaceId) {
    return NextResponse.json(
      {
        error:
          "linear_customer_id and workspace_id (or '__skipped') are required",
      },
      { status: 400 }
    );
  }
  const next = await saveManualMapping(linearCustomerId, workspaceId);
  return NextResponse.json({ ok: true, updated_at: next.updated_at });
}
