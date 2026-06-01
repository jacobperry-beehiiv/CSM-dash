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

export async function createGmailDraftFor(
  fromEmail: string,
  draft: DraftInput
): Promise<{ id: string }> {
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

  const res = await fetch(
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
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Gmail API ${res.status}: ${txt.slice(0, 300)}`);
  }
  const j = (await res.json()) as { id: string };
  return { id: j.id };
}
