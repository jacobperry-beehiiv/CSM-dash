"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Client hook that batches "last contacted via Gmail" lookups for a
 * list of customer owner emails and exposes the resolved date per
 * email. Used by the customer table and the at-risk table to overlay
 * Gmail-derived dates on top of HubSpot values so the merged result
 * shows the freshest signal we have.
 *
 * Mechanics:
 *   - On mount + whenever the target list changes, POST the unique
 *     non-empty list to /api/last-contact/gmail.
 *   - Each target can carry an optional `csmEmail` — the server
 *     routes that row's Gmail query through THAT CSM's stored token
 *     (Jacob viewing Olivia's book sees Olivia's Gmail dates, not
 *     his). Rows without csmEmail fall through to the viewer's own
 *     active Gmail connection (legacy behavior).
 *   - Hook stashes the result map in state.
 *   - Failure modes are non-fatal: a network blip / 500 leaves the
 *     map empty and pages render HubSpot values as before.
 *
 * Two distinct "no data" signals callers might care about:
 *
 *   - `scopeMissing: true` → the active CSM hasn't reconsented with
 *     the new gmail.readonly scope yet. Only fires when the batch
 *     includes at least one viewer-fallback row that hit a scope
 *     error; per-CSM-override rows swallow their own scope errors
 *     server-side since the viewer can't fix another CSM's token.
 *   - `noActiveGmail: true` → no Gmail account is connected for
 *     this browser AND every row in the batch was expecting the
 *     viewer fallback. When any row overrides csmEmail, this stays
 *     false and the batch proceeds with just those rows resolved.
 *
 * `refresh(email, csmEmail?)` re-fetches a single row bypassing
 * the server-side cache. Used by the per-row "🔄 Refresh from
 * Gmail" button.
 */

export interface GmailTarget {
  email: string;
  /** CSM whose Gmail token to use for this row. Empty / undefined
   *  routes through the viewer's active-Gmail cookie. */
  csmEmail?: string | null;
}

export interface GmailLastContactMap {
  /** email → ISO date string of the most-recent message. null when
   *  the active CSM has never emailed the target. Absent from the
   *  map when the query failed for any reason. */
  [targetEmail: string]: string | null;
}

export interface GmailMatchDetail {
  subject: string | null;
  from: string | null;
}

export interface GmailLastContactState {
  /** Date per target email. Always lower-cased keys. */
  dateMap: GmailLastContactMap;
  /** Matching-message metadata per target email — subject + from
   *  headers. Used by the detail panel's tooltip so a CSM can see
   *  WHICH message matched (e.g. "Out of office" auto-reply vs.
   *  "Re: Q3 renewal call") and decide whether the date is
   *  meaningful. */
  matchMap: Record<string, GmailMatchDetail>;
  /** True between mount and first response. */
  loading: boolean;
  /** Active CSM doesn't have gmail.readonly granted on their token. */
  scopeMissing: boolean;
  /** No active Gmail connection on this browser at all. */
  noActiveGmail: boolean;
  /** Generic failure text — surfaced as a small dim status, not a
   *  blocking error. */
  error: string | null;
  /** Force-refresh a single row's Gmail value (skips the 6h cache).
   *  Pass the ASSIGNED CSM's email when the caller is viewing
   *  another CSM's book so the row re-fetches under that CSM's
   *  token; omit to use the viewer's active-Gmail connection. */
  refresh: (email: string, csmEmail?: string | null) => Promise<void>;
}

export function useGmailLastContact(
  targets: Array<string | GmailTarget>
): GmailLastContactState {
  const [dateMap, setDateMap] = useState<GmailLastContactMap>({});
  const [matchMap, setMatchMap] = useState<
    Record<string, GmailMatchDetail>
  >({});
  const [loading, setLoading] = useState(true);
  const [scopeMissing, setScopeMissing] = useState(false);
  const [noActiveGmail, setNoActiveGmail] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Normalize + dedupe by (email, csmEmail). A stable serialization
  // is the effect dep so we don't re-fetch when the parent re-renders
  // with the same conceptual list in a different array instance.
  const { normalized, cacheKey } = useMemo(() => {
    const map = new Map<string, GmailTarget>();
    for (const t of targets) {
      const email =
        typeof t === "string"
          ? t.trim().toLowerCase()
          : (t?.email ?? "").trim().toLowerCase();
      if (!email) continue;
      const csmEmail =
        typeof t === "string"
          ? null
          : ((t?.csmEmail ?? "") + "").trim().toLowerCase() || null;
      const k = `${email}|${csmEmail ?? ""}`;
      if (!map.has(k)) map.set(k, { email, csmEmail });
    }
    const arr = Array.from(map.values()).sort((a, b) =>
      `${a.email}|${a.csmEmail ?? ""}`.localeCompare(
        `${b.email}|${b.csmEmail ?? ""}`
      )
    );
    return {
      normalized: arr,
      cacheKey: arr
        .map((t) => `${t.email}|${t.csmEmail ?? ""}`)
        .join(","),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(targets)]);

  useEffect(() => {
    if (normalized.length === 0) {
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
      body: JSON.stringify({
        targets: normalized.map((t) => ({
          email: t.email,
          csm_email: t.csmEmail ?? undefined,
        })),
      }),
    })
      .then(async (r) => {
        const json = (await r
          .json()
          .catch(() => ({}))) as {
          results?: Record<
            string,
            {
              date: string | null;
              subject?: string | null;
              from?: string | null;
              cached: boolean;
              fetched_at: string;
            }
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
        const nextDate: GmailLastContactMap = {};
        const nextMatch: Record<string, GmailMatchDetail> = {};
        for (const [email, entry] of Object.entries(json.results ?? {})) {
          const k = email.toLowerCase();
          nextDate[k] = entry.date;
          nextMatch[k] = {
            subject: entry.subject ?? null,
            from: entry.from ?? null,
          };
        }
        setDateMap(nextDate);
        setMatchMap(nextMatch);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  const refresh = useCallback(
    async (email: string, csmEmail?: string | null) => {
      const target = email.trim().toLowerCase();
      if (!target) return;
      const csm = (csmEmail ?? "").trim().toLowerCase();
      const params = new URLSearchParams({
        email: target,
        forceFresh: "1",
      });
      if (csm) params.set("csm_email", csm);
      try {
        const r = await fetch(
          `/api/last-contact/gmail?${params.toString()}`
        );
        const json = (await r.json().catch(() => ({}))) as {
          date?: string | null;
          subject?: string | null;
          from?: string | null;
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
        setMatchMap((prev) => ({
          ...prev,
          [target]: {
            subject: json.subject ?? null,
            from: json.from ?? null,
          },
        }));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to fetch");
      }
    },
    []
  );

  return {
    dateMap,
    matchMap,
    loading,
    scopeMissing,
    noActiveGmail,
    error,
    refresh,
  };
}
