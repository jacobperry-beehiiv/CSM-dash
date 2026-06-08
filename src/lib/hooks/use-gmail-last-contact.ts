"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Client hook that batches "last contacted via Gmail" lookups for a
 * list of customer owner emails and exposes the resolved date per
 * email. Used by the customer table and the at-risk table to overlay
 * Gmail-derived dates on top of HubSpot values so the merged result
 * shows the freshest signal we have.
 *
 * Mechanics:
 *   - On mount + whenever the email list changes, POST the unique
 *     non-empty list to /api/last-contact/gmail.
 *   - Server resolves via the active CSM's Gmail (cache hit OR fresh
 *     Gmail query, see lib/integrations/gmail-read.ts).
 *   - Hook stashes the result map in state.
 *   - Failure modes are non-fatal: a network blip / 500 leaves the
 *     map empty and pages render HubSpot values as before.
 *
 * Two distinct "no data" signals callers might care about:
 *
 *   - `scopeMissing: true` → the active CSM hasn't reconsented with
 *     the new gmail.readonly scope yet. Pages show a banner pointing
 *     to /settings/gmail.
 *   - `noActiveGmail: true` → no Gmail account is connected for this
 *     browser. Pages don't surface a banner here (it's the default
 *     state for CSMs who never connected Gmail at all).
 *
 * `refresh(email)` re-fetches a single row bypassing the server-side
 * cache. Used by the per-row "🔄 Refresh from Gmail" button.
 */

export interface GmailLastContactMap {
  /** email → ISO date string of the most-recent message. null when
   *  the active CSM has never emailed the target. Absent from the
   *  map when the query failed for any reason. */
  [targetEmail: string]: string | null;
}

export interface GmailLastContactState {
  /** Date per target email. Always lower-cased keys. */
  dateMap: GmailLastContactMap;
  /** True between mount and first response. */
  loading: boolean;
  /** Active CSM doesn't have gmail.readonly granted on their token. */
  scopeMissing: boolean;
  /** No active Gmail connection on this browser at all. */
  noActiveGmail: boolean;
  /** Generic failure text — surfaced as a small dim status, not a
   *  blocking error. */
  error: string | null;
  /** Force-refresh a single row's Gmail value (skips the 6h cache). */
  refresh: (email: string) => Promise<void>;
}

export function useGmailLastContact(emails: string[]): GmailLastContactState {
  const [dateMap, setDateMap] = useState<GmailLastContactMap>({});
  const [loading, setLoading] = useState(true);
  const [scopeMissing, setScopeMissing] = useState(false);
  const [noActiveGmail, setNoActiveGmail] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stringify-stable key so we don't re-fetch when the parent
  // re-renders with the same list in a different array instance.
  const uniqueKey = Array.from(
    new Set(
      emails
        .map((e) => (e ?? "").trim().toLowerCase())
        .filter((e) => e.length > 0)
    )
  )
    .sort()
    .join(",");

  useEffect(() => {
    if (!uniqueKey) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setScopeMissing(false);
    setNoActiveGmail(false);
    fetch("/api/last-contact/gmail", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails: uniqueKey.split(",") }),
    })
      .then(async (r) => {
        const json = (await r
          .json()
          .catch(() => ({}))) as {
          results?: Record<
            string,
            { date: string | null; cached: boolean; fetched_at: string }
          >;
          needs_reconsent?: boolean;
          no_active_gmail?: boolean;
          error?: string;
        };
        if (cancelled) return;
        if (r.status === 401 && json.no_active_gmail) {
          setNoActiveGmail(true);
          return;
        }
        if (r.status === 403 && json.needs_reconsent) {
          setScopeMissing(true);
          return;
        }
        if (!r.ok) {
          setError(json.error ?? `HTTP ${r.status}`);
          return;
        }
        const next: GmailLastContactMap = {};
        for (const [email, entry] of Object.entries(json.results ?? {})) {
          next[email.toLowerCase()] = entry.date;
        }
        setDateMap(next);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to fetch");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [uniqueKey]);

  const refresh = useCallback(async (email: string) => {
    const target = email.trim().toLowerCase();
    if (!target) return;
    try {
      const r = await fetch(
        `/api/last-contact/gmail?email=${encodeURIComponent(target)}&forceFresh=1`
      );
      const json = (await r.json().catch(() => ({}))) as {
        date?: string | null;
        needs_reconsent?: boolean;
        no_active_gmail?: boolean;
        error?: string;
      };
      if (r.status === 401 && json.no_active_gmail) {
        setNoActiveGmail(true);
        return;
      }
      if (r.status === 403 && json.needs_reconsent) {
        setScopeMissing(true);
        return;
      }
      if (!r.ok) {
        setError(json.error ?? `HTTP ${r.status}`);
        return;
      }
      setDateMap((prev) => ({ ...prev, [target]: json.date ?? null }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch");
    }
  }, []);

  return { dateMap, loading, scopeMissing, noActiveGmail, error, refresh };
}
