import { getValidAccessTokenFor } from "../data/gmail-token";

/**
 * Gmail API helper — creates drafts directly in the connected user's
 * Drafts folder via gmail.users.drafts.create. No OAuth handshake here;
 * tokens come from data/gmail-token.json.
 */

export interface DraftInput {
  to: string;
  /** Comma-separated list of CC addresses. Optional. */
  cc?: string;
  /** Comma-separated list of BCC addresses. Optional. */
  bcc?: string;
  subject: string;
  body_html: string;
  /** Override the From: header with a verified send-as alias on the
   *  authenticated account. When unset the draft uses the auth user's
   *  primary address. Gmail rejects with HTTP 400 if `from_email`
   *  isn't a registered alias — `createGmailDraftFor` surfaces that
   *  via its returned error. */
  from_email?: string;
}

function encodeMimeWord(s: string): string {
  // Encode anything non-ASCII so Subject lines with emoji / accents don't
  // mangle. RFC 2047 base64 form: =?UTF-8?B?<base64>?=
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const b64 = Buffer.from(s, "utf8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}

function buildRfc822(args: {
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body_html: string;
}): string {
  const lines: string[] = [
    `From: ${args.from}`,
    `To: ${args.to}`,
  ];
  if (args.cc && args.cc.trim()) lines.push(`Cc: ${args.cc.trim()}`);
  if (args.bcc && args.bcc.trim()) lines.push(`Bcc: ${args.bcc.trim()}`);
  lines.push(
    `Subject: ${encodeMimeWord(args.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    args.body_html
  );
  return lines.join("\r\n");
}

function base64UrlEncode(s: string): string {
  return Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export interface DraftCreateResult {
  /** Gmail draft id (e.g. "r12345"). */
  id: string;
  /** Underlying message id — needed for messages.modify follow-up
   *  calls and for verifying the label landed. */
  message_id?: string;
  /** True when label application via messages.modify returned 200
   *  AND the response confirmed the labelId stuck. False (with
   *  `label_error` set) when the modify call failed — the draft
   *  itself still landed; only the label is missing. */
  label_applied: boolean;
  label_error?: string;
}

export async function createGmailDraftFor(
  fromEmail: string,
  draft: DraftInput,
  opts: { labelIds?: string[] } = {}
): Promise<DraftCreateResult> {
  const token = await getValidAccessTokenFor(fromEmail);
  // `From:` is `from_email` (a verified send-as alias) when set, else
  // the authenticated account. Auth still flows through the
  // authenticated user's token — Gmail enforces that the From address
  // is one of the user's verified aliases at draft-creation time.
  const fromHeader = draft.from_email?.trim() || fromEmail;
  const raw = base64UrlEncode(
    buildRfc822({
      from: fromHeader,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      body_html: draft.body_html,
    })
  );

  const labelIds =
    opts.labelIds && opts.labelIds.length > 0 ? opts.labelIds : null;

  // Step 1 — create the draft. We DO NOT pass labelIds here even when
  // requested: Gmail's drafts.create accepts the field but treats
  // drafts as label-locked to DRAFT, so user labels get silently
  // dropped. Custom labels on drafts have to go through messages.modify
  // against the underlying message id.
  const createRes = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: { raw } }),
    }
  );
  if (!createRes.ok) {
    const txt = await createRes.text();
    throw new Error(`Gmail API ${createRes.status}: ${txt.slice(0, 300)}`);
  }
  const created = (await createRes.json()) as {
    id: string;
    message?: { id?: string; threadId?: string; labelIds?: string[] };
  };
  const messageId = created.message?.id;

  if (!labelIds) {
    return { id: created.id, message_id: messageId, label_applied: false };
  }

  // Step 2 — label the message via messages.modify. Requires
  // gmail.modify scope; the caller's bulk-create handler already
  // pre-checks the scope and skips passing labelIds when it's
  // missing, so an error here means a real failure (stale labelId,
  // network blip, etc.) and not a permissions oversight.
  if (!messageId) {
    return {
      id: created.id,
      label_applied: false,
      label_error: "draft created without a message id — can't apply label",
    };
  }
  try {
    const modifyRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ addLabelIds: labelIds }),
      }
    );
    if (!modifyRes.ok) {
      const body = await modifyRes.text().catch(() => "");
      return {
        id: created.id,
        message_id: messageId,
        label_applied: false,
        label_error: `messages.modify ${modifyRes.status}: ${body.slice(0, 200)}`,
      };
    }
    // Verify: the response includes the message's current labelIds.
    // If the labelIds we asked for don't appear, treat as not-applied
    // so the caller can surface a misleading-success heuristic. (Gmail
    // returns 200 even for label ops that no-op silently.)
    const after = (await modifyRes.json().catch(() => null)) as
      | { labelIds?: string[] }
      | null;
    const landed = labelIds.every((id) =>
      (after?.labelIds ?? []).includes(id)
    );
    return {
      id: created.id,
      message_id: messageId,
      label_applied: landed,
      label_error: landed
        ? undefined
        : "messages.modify returned 200 but the label did not stick — check Gmail label permissions",
    };
  } catch (e) {
    return {
      id: created.id,
      message_id: messageId,
      label_applied: false,
      label_error: e instanceof Error ? e.message : "modify network error",
    };
  }
}
