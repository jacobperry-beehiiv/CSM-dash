import { getValidAccessTokenFor } from "../data/gmail-token";

/**
 * Gmail API helper — creates drafts directly in the connected user's
 * Drafts folder via gmail.users.drafts.create. No OAuth handshake here;
 * tokens come from data/gmail-token.json.
 */

export interface DraftInput {
  to: string;
  subject: string;
  body_html: string;
}

function encodeMimeWord(s: string): string {
  // Encode anything non-ASCII so Subject lines with emoji / accents don't
  // mangle. RFC 2047 base64 form: =?UTF-8?B?<base64>?=
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const b64 = Buffer.from(s, "utf8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}

function buildRfc822(args: { from: string; to: string; subject: string; body_html: string }): string {
  const lines = [
    `From: ${args.from}`,
    `To: ${args.to}`,
    `Subject: ${encodeMimeWord(args.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    args.body_html,
  ];
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
  const raw = base64UrlEncode(
    buildRfc822({
      from: fromEmail,
      to: draft.to,
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
