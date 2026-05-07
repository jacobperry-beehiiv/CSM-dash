import { kvGet, kvSet } from "../storage/kv";

/**
 * Enterprise-tier ladder. Used by merge tags so emails can reference the
 * customer's current tier and the next 2-3 tiers up. Edit on /tiers.
 *
 * Persisted via the shared KV (file in dev, Postgres in prod). Seeded with
 * placeholder pricing on first run — owners should update these to match
 * the current Enterprise rate card.
 */

export interface EnterpriseTier {
  /** Display label for the tier, e.g. "500K". */
  name: string;
  /** Maximum subscribers included in the tier. */
  max_subs: number;
  /** Monthly contract price (USD). */
  monthly_usd: number;
  /** Annual contract price (USD). */
  annual_usd: number;
  /** Optional notes shown only in the editor. */
  notes?: string;
}

const SEED: EnterpriseTier[] = [
  { name: "100K", max_subs: 100_000, monthly_usd: 1500, annual_usd: 15_000 },
  { name: "250K", max_subs: 250_000, monthly_usd: 3000, annual_usd: 30_000 },
  { name: "500K", max_subs: 500_000, monthly_usd: 5000, annual_usd: 50_000 },
  { name: "1M", max_subs: 1_000_000, monthly_usd: 8000, annual_usd: 80_000 },
  { name: "2.5M", max_subs: 2_500_000, monthly_usd: 15_000, annual_usd: 150_000 },
  { name: "5M", max_subs: 5_000_000, monthly_usd: 25_000, annual_usd: 250_000 },
  { name: "10M", max_subs: 10_000_000, monthly_usd: 40_000, annual_usd: 400_000 },
];

const KEY = "enterprise-tiers";

let cache: EnterpriseTier[] | null = null;

async function persist(list: EnterpriseTier[]) {
  // Always store sorted ascending by max_subs so consumers can rely on order.
  const sorted = [...list].sort((a, b) => a.max_subs - b.max_subs);
  await kvSet(KEY, sorted);
  cache = sorted;
}

export async function listTiers(): Promise<EnterpriseTier[]> {
  if (cache) return cache;
  const stored = await kvGet<EnterpriseTier[]>(KEY);
  if (stored) {
    cache = [...stored].sort((a, b) => a.max_subs - b.max_subs);
  } else {
    await persist(SEED);
  }
  return cache!;
}

export async function replaceTiers(
  list: EnterpriseTier[]
): Promise<EnterpriseTier[]> {
  // Defensive validation — bail rather than persist garbage that would break
  // the merge-tag rendering downstream.
  for (const t of list) {
    if (!t.name || typeof t.name !== "string") {
      throw new Error("Each tier needs a non-empty `name`.");
    }
    if (typeof t.max_subs !== "number" || t.max_subs <= 0) {
      throw new Error(`Tier ${t.name}: max_subs must be > 0.`);
    }
    if (typeof t.monthly_usd !== "number" || t.monthly_usd < 0) {
      throw new Error(`Tier ${t.name}: monthly_usd must be >= 0.`);
    }
    if (typeof t.annual_usd !== "number" || t.annual_usd < 0) {
      throw new Error(`Tier ${t.name}: annual_usd must be >= 0.`);
    }
  }
  await persist(list);
  return cache!;
}
