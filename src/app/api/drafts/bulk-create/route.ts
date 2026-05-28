import { NextResponse } from "next/server";
import { createGmailDraftFor } from "@/lib/integrations/gmail-api";
import { getActiveEmail } from "@/lib/data/active-user";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface PostBody {
  drafts: Array<{
    to: string;
    /** Comma-separated CC list. Optional. */
    cc?: string;
    /** Comma-separated BCC list. Optional. */
    bcc?: string;
    subject: string;
    body_html: string;
  }>;
}

export async function POST(req: Request) {
  try {
    const activeEmail = await getActiveEmail();
    if (!activeEmail) {
      return NextResponse.json(
        {
          error:
            "No Gmail account connected for this browser. Visit /settings/gmail.",
        },
        { status: 401 }
      );
    }

    const body = (await req.json()) as PostBody;
    if (!Array.isArray(body.drafts) || body.drafts.length === 0) {
      return NextResponse.json(
        { error: "drafts must be a non-empty array" },
        { status: 400 }
      );
    }

    let created = 0;
    let failed = 0;
    const errors: Array<{ to: string; error: string }> = [];
    const ids: string[] = [];

    for (const d of body.drafts) {
      try {
        const r = await createGmailDraftFor(activeEmail, {
          to: d.to,
          cc: d.cc,
          bcc: d.bcc,
          subject: d.subject,
          body_html: d.body_html,
        });
        ids.push(r.id);
        created++;
      } catch (e) {
        failed++;
        errors.push({
          to: d.to,
          error: e instanceof Error ? e.message : "unknown",
        });
        // Don't bail — keep going so the user gets as many drafts as possible.
      }
    }

    return NextResponse.json({
      created,
      failed,
      ids,
      created_in: activeEmail,
      errors: errors.slice(0, 5),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
