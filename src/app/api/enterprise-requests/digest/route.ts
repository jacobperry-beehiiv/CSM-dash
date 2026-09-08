import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { runEnterpriseRequestsDigest } from "@/lib/engines/enterprise-requests-digest";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/enterprise-requests/digest
 *
 * Fires the weekly Enterprise-Request-Loop DM sweep. Dual-auth:
 *   • session cookie (any signed-in user — the /settings/slack UI
 *     surfaces a manual trigger for the digest kind), OR
 *   • `Authorization: Bearer <CRON_SECRET>` (GitHub Actions cron).
 *
 * Query params:
 *   • `dryRun=1` — compose messages without posting. Returns the
 *     rendered text + rows per CSM.
 *   • `csm=<handle>` — limit to one CSM. Useful for a preview post
 *     from the settings page before enabling the flag for everyone.
 *
 * Response mirrors runEnterpriseRequestsDigest — the same shape
 * whether posted for real or dry-run.
 */

async function isAuthed(req: Request): Promise<boolean> {
  const session = await auth();
  if (session?.user?.email) return true;
  const cron = process.env.CRON_SECRET;
  if (!cron) return false;
  const auth_h = req.headers.get("authorization") ?? "";
  return auth_h === `Bearer ${cron}`;
}

export async function POST(req: Request) {
  if (!(await isAuthed(req))) {
    return NextResponse.json(
      { error: "Sign in or Bearer CRON_SECRET required." },
      { status: 401 }
    );
  }
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const csmHandle = url.searchParams.get("csm")?.trim() || undefined;
  const cronHeader = req.headers.get("authorization")?.startsWith("Bearer ")
    ? "cron"
    : "manual";
  try {
    const result = await runEnterpriseRequestsDigest({
      dryRun,
      csmHandle,
      triggeredBy: cronHeader,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error
            ? e.message
            : "enterprise-requests digest failed",
      },
      { status: 500 }
    );
  }
}
