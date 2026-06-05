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
    /** Caller-supplied stable identifier for each input draft (e.g.
     *  the customer's Stripe customer_id or workspace_id). Echoed back
     *  in `succeeded_tracking_ids` / `failed_tracking_ids` so the
     *  client can correlate which input drafts actually landed and
     *  ONLY stamp lifecycle state for those. Pre-tracking-id we passed
     *  every selected customer's id to onDraftCreated regardless of
     *  whether their draft succeeded — overstamping in the partial-
     *  failure case. */
    tracking_id?: string;
  }>;
}

/**
 * POST /api/drafts/bulk-create
 *
 * Sequentially creates Gmail drafts for each row in the request body.
 * Returns a per-draft outcome split (succeeded_tracking_ids /
 * failed_tracking_ids) so the caller can stamp lifecycle state
 * accurately and surface specific failures to the user.
 *
 * Logs every action: receipt summary, per-draft attempt + result,
 * final tally. Failures get their full Gmail-API error string in the
 * `errors[]` response field (first 10) AND in Vercel logs (all of
 * them) so partial batches don't go dark.
 */
export async function POST(req: Request) {
  try {
    const activeEmail = await getActiveEmail();
    if (!activeEmail) {
      console.warn(
        "[drafts/bulk-create] No active Gmail connection — rejecting"
      );
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
      console.warn(
        "[drafts/bulk-create] Empty/missing drafts array — rejecting"
      );
      return NextResponse.json(
        { error: "drafts must be a non-empty array" },
        { status: 400 }
      );
    }

    const requestId = Math.random().toString(36).slice(2, 8);
    console.log("[drafts/bulk-create] Request received", {
      requestId,
      activeEmail,
      count: body.drafts.length,
      with_cc: body.drafts.filter((d) => d.cc).length,
      with_bcc: body.drafts.filter((d) => d.bcc).length,
      with_from_alias: body.drafts.filter((d) => d.from).length,
      with_tracking_id: body.drafts.filter((d) => d.tracking_id).length,
    });

    let created = 0;
    let failed = 0;
    let alias_fallbacks = 0;
    const errors: Array<{
      to: string;
      tracking_id?: string;
      error: string;
    }> = [];
    const ids: string[] = [];
    const succeeded_tracking_ids: string[] = [];
    const failed_tracking_ids: string[] = [];

    let i = 0;
    for (const d of body.drafts) {
      i++;
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
        if (d.tracking_id) succeeded_tracking_ids.push(d.tracking_id);
        console.log("[drafts/bulk-create] Draft created", {
          requestId,
          n: `${i}/${body.drafts.length}`,
          to_preview: previewEmail(d.to),
          gmail_draft_id: r.id,
          tracking_id: d.tracking_id ?? null,
          used_alias: d.from ?? null,
        });
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
          console.warn(
            "[drafts/bulk-create] Alias rejected — retrying without",
            {
              requestId,
              n: `${i}/${body.drafts.length}`,
              alias: d.from,
              error: msg.slice(0, 200),
            }
          );
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
            if (d.tracking_id) succeeded_tracking_ids.push(d.tracking_id);
            console.log(
              "[drafts/bulk-create] Draft created (alias fallback)",
              {
                requestId,
                n: `${i}/${body.drafts.length}`,
                to_preview: previewEmail(d.to),
                gmail_draft_id: r.id,
                tracking_id: d.tracking_id ?? null,
              }
            );
            continue;
          } catch (e2) {
            const msg2 = e2 instanceof Error ? e2.message : "unknown";
            failed++;
            errors.push({
              to: d.to,
              tracking_id: d.tracking_id,
              error: msg2,
            });
            if (d.tracking_id) failed_tracking_ids.push(d.tracking_id);
            console.error(
              "[drafts/bulk-create] Draft failed (alias fallback also failed)",
              {
                requestId,
                n: `${i}/${body.drafts.length}`,
                to_preview: previewEmail(d.to),
                tracking_id: d.tracking_id ?? null,
                error: msg2.slice(0, 300),
              }
            );
            continue;
          }
        }
        failed++;
        errors.push({ to: d.to, tracking_id: d.tracking_id, error: msg });
        if (d.tracking_id) failed_tracking_ids.push(d.tracking_id);
        console.error("[drafts/bulk-create] Draft failed", {
          requestId,
          n: `${i}/${body.drafts.length}`,
          to_preview: previewEmail(d.to),
          tracking_id: d.tracking_id ?? null,
          error: msg.slice(0, 300),
        });
        // Don't bail — keep going so the user gets as many drafts as possible.
      }
    }

    console.log("[drafts/bulk-create] Done", {
      requestId,
      created,
      failed,
      alias_fallbacks,
      success_rate:
        body.drafts.length > 0
          ? `${Math.round((created / body.drafts.length) * 100)}%`
          : "n/a",
    });

    return NextResponse.json({
      created,
      failed,
      ids,
      created_in: activeEmail,
      alias_fallbacks,
      succeeded_tracking_ids,
      failed_tracking_ids,
      errors: errors.slice(0, 10),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[drafts/bulk-create] Top-level handler error", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** Redact emails in logs — first chars + domain, e.g. "ja***@beehiiv.com".
 *  Loud enough to debug, quiet enough to not splash full PII into
 *  Vercel's log stream. */
function previewEmail(raw: string): string {
  const trimmed = (raw ?? "").trim();
  // Bulk drafts can include multiple comma-separated recipients (CC
  // strings, etc.); just preview the first for log brevity.
  const first = trimmed.split(",")[0]?.trim() ?? "";
  const at = first.indexOf("@");
  if (at <= 0) return first;
  const local = first.slice(0, at);
  const domain = first.slice(at);
  if (local.length <= 3) return `${local}${domain}`;
  return `${local.slice(0, 2)}***${domain}`;
}
