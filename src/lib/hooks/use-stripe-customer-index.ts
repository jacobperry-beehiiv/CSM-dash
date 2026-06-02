"use client";

import { useEffect, useState } from "react";

/**
 * Lazily-loaded stripe_customer_id → workspace_id (organization_id)
 * map. Lets Past Due + Approaching Enterprise rows resolve to a
 * workspace even when the customer book (q10600 snapshot) doesn't
 * include that customer — non-enterprise / self-serve accounts often
 * aren't in q10600 but DO show up in the billing-side questions
 * (q24620, q13268).
 *
 * Same caching pattern as use-publications-index: module-level cache
 * deduped across panel mounts on /am, with a 5-minute HTTP cache on
 * the endpoint itself for cold-load smoothing.
 *
 * Failure mode: silently returns an empty map. The caller's fallback
 * chain (book lookup → this index → row-only synthesis) keeps the
 * detail panel renderable even when the network call fails.
 */

interface IndexShape {
  stripe2ws: Record<string, string>;
}

let CACHE: IndexShape | null = null;
let IN_FLIGHT: Promise<IndexShape> | null = null;

async function fetchOnce(): Promise<IndexShape> {
  if (CACHE) return CACHE;
  if (IN_FLIGHT) return IN_FLIGHT;
  IN_FLIGHT = fetch("/api/customers/stripe-index", {
    credentials: "same-origin",
  })
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as IndexShape;
      const safe: IndexShape = { stripe2ws: j.stripe2ws ?? {} };
      CACHE = safe;
      return safe;
    })
    .catch(() => {
      const empty: IndexShape = { stripe2ws: {} };
      CACHE = empty;
      return empty;
    })
    .finally(() => {
      IN_FLIGHT = null;
    });
  return IN_FLIGHT;
}

export interface StripeCustomerIndex {
  /** stripe_customer_id → workspace_id. Empty map until the fetch
   *  resolves; safe to read on every render. */
  stripe2ws: Record<string, string>;
  ready: boolean;
}

const EMPTY: StripeCustomerIndex = { stripe2ws: {}, ready: false };

export function useStripeCustomerIndex(): StripeCustomerIndex {
  const [data, setData] = useState<IndexShape | null>(CACHE);

  useEffect(() => {
    let cancelled = false;
    void fetchOnce().then((next) => {
      if (!cancelled) setData(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data) return EMPTY;
  return { stripe2ws: data.stripe2ws, ready: true };
}
