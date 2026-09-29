#!/usr/bin/env tsx
/**
 * Regression cover for parseIntakeMessage across the two body shapes
 * it actually receives.
 *
 * Every pattern in the parser was written against Slack message text.
 * When the Linear-comment scan grew a description-parsing path, the
 * same structured block arriving from a Linear ISSUE DESCRIPTION hit
 * two encodings Slack never produces — blockquote prefixes and a
 * URL-encoded pipe inside a markdown mailto link — and extraction
 * silently returned nothing usable. The first production run reported
 * 228 descriptions parsed and 228 unresolvable, against 21/21
 * comment-sourced matches resolving fine.
 *
 * The invariant these tests pin: the SAME structured fields must
 * parse identically whether they arrive Slack-shaped or Linear-shaped.
 *
 * Run: npx tsx src/lib/integrations/__tests__/intake-parser.test.ts
 */
import { parseIntakeMessage } from "../enterprise-requests-slack-intake-parser";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check<T>(name: string, got: T, expected: T) {
  if (JSON.stringify(got) === JSON.stringify(expected)) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    failures.push(
      `${name}\n   got=${JSON.stringify(got)}\n   expected=${JSON.stringify(expected)}`
    );
    console.log(`FAIL  ${name}`);
    console.log(`      got=${JSON.stringify(got)}`);
    console.log(`      expected=${JSON.stringify(expected)}`);
  }
}

const PUB = "8cfe5d27-8f83-49ca-a9ff-415eb27e1125";
const EMAIL = "austin@dailydrop.com";

// Verbatim shape of BEE-24879's description — the ticket that shipped
// a subscription-export API for Daily Drop and never reached the
// tracker.
const linearDescription = [
  "> `What part of the app?`",
  "> API / Developer Platform + Exports (Settings > Export Data)",
  "> `User Email`",
  `> [mailto:${EMAIL}|${EMAIL}](<mailto:${EMAIL}%7C${EMAIL}>)`,
  "> `User status`",
  "> Current enterprise user request",
  "> `Publication ID`",
  `> ${PUB} — Daily Drop`,
].join("\n");

const slackShape = [
  "`User Email`",
  `<mailto:${EMAIL}|${EMAIL}>`,
  "`Publication ID`",
  PUB,
].join("\n");

const fromLinear = parseIntakeMessage(linearDescription);
const fromSlack = parseIntakeMessage(slackShape);

check("linear description: publication id", fromLinear.publication_ids, [PUB]);
check("linear description: owner email", fromLinear.owner_emails, [EMAIL]);
check("slack shape: publication id", fromSlack.publication_ids, [PUB]);
check("slack shape: owner email", fromSlack.owner_emails, [EMAIL]);

// The invariant, stated directly.
check(
  "both shapes agree on publication id",
  fromLinear.publication_ids,
  fromSlack.publication_ids
);
check(
  "both shapes agree on owner email",
  fromLinear.owner_emails,
  fromSlack.owner_emails
);

// A blockquoted colon-form line, since the skill's phrasing has
// varied and the blockquote is the part that broke.
const colonForm = "> Publication ID: " + PUB + "\n> User Email: " + EMAIL;
const fromColon = parseIntakeMessage(colonForm);
check("blockquoted colon form: publication id", fromColon.publication_ids, [PUB]);
check("blockquoted colon form: owner email", fromColon.owner_emails, [EMAIL]);

// No customer signal must stay empty — the scan's fast-drop depends
// on it, and a false positive here would inject junk rows.
const noSignal = parseIntakeMessage(
  "> Some prose about an unrelated bug with no identifiers at all."
);
check("no signal: publication ids empty", noSignal.publication_ids, []);
check("no signal: owner emails empty", noSignal.owner_emails, []);

console.log("");
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
