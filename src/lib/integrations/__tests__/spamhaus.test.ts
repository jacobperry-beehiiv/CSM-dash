#!/usr/bin/env tsx
/**
 * Unit tests for the Spamhaus DBL helper. Same lightweight
 * pass/fail harness the migration-warmup tests use — no framework,
 * just PASS/FAIL logging + exit code.
 *
 * Run: npx tsx src/lib/integrations/__tests__/spamhaus.test.ts
 */

import {
  checkSpamhausDBL,
  checkSpamhausDBLBatch,
  normalizeDomain,
  type Resolve4,
  type SpamhausCheck,
} from "../spamhaus";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check<T>(name: string, got: T, expected: T) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) {
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

// ─── normalizeDomain ─────────────────────────────────────────────────────

check("normalize: plain", normalizeDomain("Example.com"), "example.com");
check(
  "normalize: strips protocol",
  normalizeDomain("https://Example.com/path"),
  "example.com"
);
check(
  "normalize: strips www + port",
  normalizeDomain("www.example.com:8080"),
  "example.com"
);
check(
  "normalize: strips trailing dot",
  normalizeDomain("example.com."),
  "example.com"
);
check("normalize: empty", normalizeDomain(""), null);
check("normalize: whitespace only", normalizeDomain("   "), null);
check("normalize: no dot", normalizeDomain("localhost-alt"), null);
check("normalize: not a string", normalizeDomain(null), null);
check("normalize: pure numeric", normalizeDomain("127.0.0.1"), null);

// ─── checkSpamhausDBL — mocked resolvers ─────────────────────────────────

/** Builds a resolver from a fixed hostname→(addresses|error) table. */
function makeResolver(
  table: Record<string, string[] | NodeJS.ErrnoException>
): Resolve4 {
  return async (hostname: string) => {
    const entry = table[hostname];
    if (!entry) {
      const err = Object.assign(new Error("NXDOMAIN"), {
        code: "ENOTFOUND",
      }) as NodeJS.ErrnoException;
      throw err;
    }
    if (entry instanceof Error) throw entry;
    return entry;
  };
}

async function run() {
  // Clean domain — resolver throws ENOTFOUND (NXDOMAIN).
  const clean = await checkSpamhausDBL(
    "example.com",
    makeResolver({})
  );
  check("clean domain: status", clean.status, "clean");
  check("clean domain: code", clean.code, null);
  check("clean domain: reason", clean.reason, null);
  check("clean domain: normalized", clean.domain, "example.com");

  // Listed as spam.
  const spam = await checkSpamhausDBL(
    "bad-actor.com",
    makeResolver({
      "bad-actor.com.dbl.spamhaus.org": ["127.0.1.2"],
    })
  );
  check("listed spam: status", spam.status, "listed");
  check("listed spam: code", spam.code, "127.0.1.2");
  check("listed spam: category", spam.category, "spam");

  // Listed as botnet C&C.
  const botnet = await checkSpamhausDBL(
    "cnc.example.net",
    makeResolver({
      "cnc.example.net.dbl.spamhaus.org": ["127.0.1.6"],
    })
  );
  check("listed botnet: category", botnet.category, "botnet");

  // Listed with a code we don't have a label for — reports "unknown"
  // category but still status: "listed" (any 127.0.1.x counts).
  const unknownCode = await checkSpamhausDBL(
    "weird.co",
    makeResolver({ "weird.co.dbl.spamhaus.org": ["127.0.1.99"] })
  );
  check("listed unknown code: status", unknownCode.status, "listed");
  check("listed unknown code: category", unknownCode.category, "unknown");

  // Timeout → status "unknown", reason "DNS timeout". The resolver
  // hangs long enough for the withTimeout wrapper to trip.
  const timeoutResolver: Resolve4 = () =>
    new Promise((_, reject) => {
      // Never resolves within the 2000ms budget in the real code;
      // for the test we synthesize the timeout error directly so we
      // don't actually wait.
      const err = Object.assign(new Error("timeout"), {}) as Error;
      reject(err);
    });
  const timed = await checkSpamhausDBL("slow.example.org", timeoutResolver);
  check("timeout: status", timed.status, "unknown");
  check("timeout: reason", timed.reason, "DNS timeout");

  // Server failure (SERVFAIL) → unknown, reason describes the error.
  const servfail: Resolve4 = async () => {
    const err = Object.assign(new Error("server failure"), {
      code: "ESERVFAIL",
    }) as NodeJS.ErrnoException;
    throw err;
  };
  const failed = await checkSpamhausDBL("broken.example.org", servfail);
  check("SERVFAIL: status", failed.status, "unknown");
  check(
    "SERVFAIL: reason mentions code",
    /ESERVFAIL/.test(failed.reason ?? ""),
    true
  );

  // Beehiiv-owned domain — skipped without any resolver call.
  let touched = false;
  const spyResolver: Resolve4 = async () => {
    touched = true;
    return ["127.0.1.2"];
  };
  const skipped = await checkSpamhausDBL("mail.beehiiv.com", spyResolver);
  check("beehiiv domain: skipped without resolve", touched, false);
  check("beehiiv domain: status", skipped.status, "clean");
  check(
    "beehiiv domain: reason",
    skipped.reason,
    "beehiiv-owned domain — skipped"
  );

  // Empty domain — never touches the resolver.
  let empty_touched = false;
  const empty = await checkSpamhausDBL("", async () => {
    empty_touched = true;
    return [];
  });
  check("empty domain: unknown status", empty.status, "unknown");
  check("empty domain: never resolved", empty_touched, false);

  // Batch dedupes + normalizes on the way in. `www.foo.com` and
  // `foo.com` become one query.
  const batchResolver: Resolve4 = async (hostname) => {
    if (hostname === "foo.com.dbl.spamhaus.org") return ["127.0.1.2"];
    if (hostname === "bar.com.dbl.spamhaus.org") {
      const err = Object.assign(new Error("nxdomain"), {
        code: "ENOTFOUND",
      }) as NodeJS.ErrnoException;
      throw err;
    }
    return [];
  };
  const batch: SpamhausCheck[] = await checkSpamhausDBLBatch(
    ["foo.com", "www.foo.com", "bar.com", "", "not-a-domain"],
    batchResolver
  );
  check("batch: dedupes to 2 results", batch.length, 2);
  const byDomain = new Map(batch.map((b) => [b.domain, b] as const));
  check("batch: foo listed", byDomain.get("foo.com")?.status, "listed");
  check("batch: bar clean", byDomain.get("bar.com")?.status, "clean");
}

run()
  .then(() => {
    console.log("");
    console.log(`Results: ${pass} passed, ${fail} failed`);
    if (failures.length > 0) {
      console.log("");
      console.log("Failures:");
      for (const f of failures) console.log(`  - ${f}`);
    }
    process.exit(fail > 0 ? 1 : 0);
  })
  .catch((e) => {
    console.error("Test harness threw:", e);
    process.exit(2);
  });
