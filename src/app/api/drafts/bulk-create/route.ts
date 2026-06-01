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
    /** Optional send-as alias. Template-supplied. When Gmail rejects
     *  the alias (HTTP 400 — alias not verified on the auth account)
     *  the server retries once without it so the draft still lands. */
    from?: string;
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
    /** Drafts where Gmail rejected the requested `from` alias and we
     *  silently fell back to the auth account's primary. Surfaced so
     *  the UI can warn that the alias isn't set up on this CSM's
     *  Gmail without nuking the draft entirely. */
    let alias_fallbacks = 0;
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
          from_email: d.from,
        });
        ids.push(r.id);
        created++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unknown";
        // Gmail returns 400 with a "Delegation denied" / "From: address
        // is not a registered alternate identity" message when the
        // From alias isn't verified on the auth account. Retry once
        // without the alias so the draft still lands — the user can
        // flip the From dropdown inside Gmail if they really want it.
        const looksLikeAliasReject =
          d.from && /Gmail API 400/.test(msg);
        if (looksLikeAliasReject) {
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
            alias_fallbacks++;
            continue;
          } catch (e2) {
            // Fallback also failed — fall through to the error path.
            failed++;
            errors.push({
              to: d.to,
              error: e2 instanceof Error ? e2.message : "unknown",
            });
            continue;
          }
        }
        failed++;
        errors.push({ to: d.to, error: msg });
        // Don't bail — keep going so the user gets as many drafts as possible.
      }
    }

    return NextResponse.json({
      created,
      failed,
      ids,
      created_in: activeEmail,
      alias_fallbacks,
      errors: errors.slice(0, 5),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
