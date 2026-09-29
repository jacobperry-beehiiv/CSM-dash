#!/usr/bin/env tsx
/**
 * CI guard: every endpoint a GitHub Actions cron POSTs to must be
 * exempt from the proxy's login redirect in src/proxy.ts.
 *
 * Without the exemption the proxy 307s the cron to /login BEFORE the
 * route's own Bearer-CRON_SECRET check can run, so the token is never
 * looked at and the workflow exits 1. The failure is invisible unless
 * someone opens the Actions tab — a nightly job that has never once
 * succeeded looks exactly like one nobody has needed yet.
 *
 * This has now bitten at least five times (refresh-cadence, wins,
 * renewal-milestones, the whole enterprise-requests namespace, and
 * lifecycle's live-quarter sweep). Each was found by noticing red
 * runs weeks later. This check turns that into a build failure.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const proxy = readFileSync("src/proxy.ts", "utf8");
const prefixes = [...proxy.matchAll(/startsWith\("(\/api\/[^"]+)"/g)].map(
  (m) => m[1]
);

const dir = ".github/workflows";
const endpoints = new Set<string>();
for (const f of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
  const body = readFileSync(join(dir, f), "utf8");
  for (const m of body.matchAll(
    /\$\{DASHBOARD_URL\}(\/api\/[A-Za-z0-9/_-]+)/g
  )) {
    endpoints.add(m[1]);
  }
}

const unexempt = [...endpoints]
  .filter((ep) => !prefixes.some((p) => ep.startsWith(p)))
  .sort();

if (unexempt.length > 0) {
  console.error(
    "\nCron endpoints NOT exempt from the proxy login redirect:\n" +
      unexempt.map((e) => `  ${e}`).join("\n") +
      "\n\nThese will 307 to /login and the workflow will exit 1.\n" +
      "Add a `pathname.startsWith(...)` exemption in src/proxy.ts.\n" +
      "Only do so once the route enforces its own auth — the\n" +
      "exemption skips the redirect, it does not grant access.\n"
  );
  process.exit(1);
}
console.log(
  `cron-exemptions: ${endpoints.size} cron endpoint(s) checked, all exempt.`
);
