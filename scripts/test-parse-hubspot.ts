import { parseHubspotCompanyInput } from "../src/lib/integrations/slack-assign";

type Expected =
  | { kind: "company"; id: string }
  | { kind: "deal"; id: string }
  | null;

const cases: Array<[string, Expected]> = [
  // Companies — explicit
  ["22204103285", { kind: "company", id: "22204103285" }],
  ["https://app.hubspot.com/contacts/123/company/22204103285", { kind: "company", id: "22204103285" }],
  ["https://app.hubspot.com/contacts/123/record/0-2/22204103285", { kind: "company", id: "22204103285" }],
  ["https://app.hubspot.com/contacts/123/record/0-2/22204103285/view/all/", { kind: "company", id: "22204103285" }],
  ["  22204103285  ", { kind: "company", id: "22204103285" }],
  // Deals
  ["https://app.hubspot.com/contacts/21568530/record/0-3/58404245581/", { kind: "deal", id: "58404245581" }],
  ["https://app.hubspot.com/contacts/21568530/record/0-3/58404245581", { kind: "deal", id: "58404245581" }],
  ["https://app.hubspot.com/contacts/123/deal/58404245581", { kind: "deal", id: "58404245581" }],
  // Invalid
  ["not-an-id", null],
  ["", null],
  ["https://example.com/no/match", null],
];

let pass = 0;
let fail = 0;
for (const [input, expected] of cases) {
  const got = parseHubspotCompanyInput(input);
  const ok =
    (got === null && expected === null) ||
    (got !== null &&
      expected !== null &&
      got.kind === expected.kind &&
      got.id === expected.id);
  console.log(
    ok ? "PASS" : "FAIL",
    JSON.stringify(input),
    "→",
    JSON.stringify(got),
    "(expected",
    JSON.stringify(expected) + ")"
  );
  if (ok) pass++;
  else fail++;
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
