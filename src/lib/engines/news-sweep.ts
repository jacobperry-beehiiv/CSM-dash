import { loadCustomers } from "../data/load-customers";
import { fetchNewsForCompany } from "../integrations/google-news";
import { saveNewsCache } from "../data/news-cache";

/**
 * Daily sweep — walks the customer book, fires the three Google News
 * RSS queries per workspace, writes each result to KV. The homepage
 * BookNewsPanel reads exclusively from this cache (no live fetches
 * on home-page load), so this sweep is what keeps it fresh.
 *
 * Concurrency is capped at 5 parallel fetchers — each customer
 * triggers three RSS calls upstream, so a fleet of 5 concurrent
 * workspaces = 15 in-flight requests to Google. Empirically that
 * stays well under any throttling threshold; the whole sweep
 * finishes in ~60-120s for a 150-customer book.
 *
 * Soft-fails per workspace. One customer's fetch failure doesn't
 * abort the sweep; the failure gets logged and we move on. The
 * result summary reports `processed`, `succeeded`, `with_headlines`
 * so the GH Actions log makes the failure rate visible without
 * needing to crawl Vercel logs.
 */

const CONCURRENCY = 5;

export interface NewsSweepResult {
  generated_at: string;
  triggered_by: "cron" | "manual";
  dry_run: boolean;
  processed: number;
  succeeded: number;
  failed: number;
  with_headlines: number;
  total_headlines: number;
  /** First N failure messages so a partial outage shows up in the
   *  workflow log without dumping every error. */
  failures: Array<{ workspace_id: string; company_name: string; reason: string }>;
}

export async function runNewsSweep(args: {
  dryRun: boolean;
  triggeredBy: "cron" | "manual";
  /** Optional scope override. When unset, sweeps every workspace in
   *  the book with a resolvable company name. */
  workspaceIds?: string[];
}): Promise<NewsSweepResult> {
  const customers = await loadCustomers();
  const candidates = customers
    .filter((c) =>
      args.workspaceIds ? args.workspaceIds.includes(c.workspace_id ?? "") : true
    )
    .filter((c) => Boolean(c.workspace_id))
    .map((c) => ({
      workspace_id: c.workspace_id as string,
      company_name: (c.company_name ?? c.workspace_name ?? "").trim(),
    }))
    .filter((c) => c.company_name.length > 0);

  const result: NewsSweepResult = {
    generated_at: new Date().toISOString(),
    triggered_by: args.triggeredBy,
    dry_run: args.dryRun,
    processed: 0,
    succeeded: 0,
    failed: 0,
    with_headlines: 0,
    total_headlines: 0,
    failures: [],
  };

  if (args.dryRun) {
    result.processed = candidates.length;
    return result;
  }

  // Concurrency-capped worker pool. Plain Promise.all with a chunked
  // slice would also work but the staircase effect (slow customer
  // blocking the whole batch) hurts wall-clock; this lets each slot
  // pull the next task as soon as it frees.
  const queue = [...candidates];
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return result;

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) return;
      result.processed++;
      try {
        const headlines = await fetchNewsForCompany(next.company_name);
        await saveNewsCache(next.workspace_id, headlines);
        result.succeeded++;
        if (headlines.length > 0) {
          result.with_headlines++;
          result.total_headlines += headlines.length;
        }
      } catch (e) {
        result.failed++;
        if (result.failures.length < 10) {
          result.failures.push({
            workspace_id: next.workspace_id,
            company_name: next.company_name,
            reason: e instanceof Error ? e.message : String(e),
          });
        }
        console.warn(
          `[news-sweep] failed for ${next.company_name} (${next.workspace_id}):`,
          e instanceof Error ? e.message : e
        );
      }
    }
  }
}
