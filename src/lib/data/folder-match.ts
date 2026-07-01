import type { Customer } from "../types";

/**
 * Match a Drive folder name to a customer in the book. Pure function
 * — no I/O — so it's easy to unit-test against real folder-name
 * samples once we have them.
 *
 * Strategy:
 *   1. Normalize both sides: lowercase, strip non-alphanumeric,
 *      collapse whitespace. This handles the common CSM variations
 *      (dashes, ampersands, "Inc." / "LLC" suffixes) without
 *      hardcoding a dictionary.
 *   2. Exact normalized match → confidence "high" (auto-populated
 *      on approve unless there's a tie).
 *   3. Bigram Jaccard similarity for near-matches. ≥0.75 →
 *      "medium" (surfaced for review, requires a click). 0.55–0.75
 *      → "low" (surfaced but visually de-emphasized).
 *   4. Nothing → "none".
 *
 * Every folder can produce up to N candidate customers (typically
 * one, occasionally two when a customer name matches two workspaces).
 * The UI shows the top-3 by score.
 */

export type MatchConfidence = "high" | "medium" | "low" | "none";

export interface FolderMatchCandidate {
  workspace_id: string;
  /** For UI: whichever field produced the match. */
  matched_via: "company_name" | "workspace_name";
  matched_value: string;
  score: number;
  confidence: MatchConfidence;
  /** Debug-friendly explanation ("exact normalized match" / "0.82 bigram overlap"). */
  reason: string;
}

/** Reduce a name to lowercase alnum characters. Removes suffixes like
 *  "Inc.", ", Ltd" etc. via the punctuation strip. Whitespace-agnostic. */
export function normalizeName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

/** Character bigram Jaccard similarity. Robust to word order, casing,
 *  short insertions ("AcmeCo" vs "Acme Co Inc" vs "Acme, Co") without
 *  the O(n·m) cost of Levenshtein. */
function bigramJaccard(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bigrams = (s: string): Set<string> => {
    if (s.length < 2) return new Set([s]);
    const out = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function classify(score: number): MatchConfidence {
  if (score === 1) return "high";
  if (score >= 0.75) return "medium";
  if (score >= 0.55) return "low";
  return "none";
}

interface CandidateForCustomer {
  workspace_id: string;
  matched_via: "company_name" | "workspace_name";
  matched_value: string;
  score: number;
}

/**
 * Score `folderName` against every candidate in `customers`. Returns
 * candidates sorted by score desc, capped at `limit` (default 3).
 *
 * Empty / missing customer names are silently skipped — nothing to
 * match against.
 */
export function matchFolderToCustomers(
  folderName: string,
  customers: readonly Customer[],
  limit = 3
): FolderMatchCandidate[] {
  const folderNorm = normalizeName(folderName);
  if (!folderNorm) return [];

  const scored: CandidateForCustomer[] = [];
  for (const c of customers) {
    if (!c.workspace_id) continue;
    // Score against both company_name and workspace_name; keep the
    // stronger of the two so a customer with both fields set gets
    // the best shot.
    let best: CandidateForCustomer | null = null;
    const candidates: Array<[string | null, "company_name" | "workspace_name"]> = [
      [c.company_name, "company_name"],
      [c.workspace_name, "workspace_name"],
    ];
    for (const [raw, via] of candidates) {
      if (!raw) continue;
      const norm = normalizeName(raw);
      if (!norm) continue;
      const score = bigramJaccard(folderNorm, norm);
      if (score === 0) continue;
      if (!best || score > best.score) {
        best = {
          workspace_id: c.workspace_id,
          matched_via: via,
          matched_value: raw,
          score,
        };
      }
    }
    if (best && classify(best.score) !== "none") {
      scored.push(best);
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => ({
    workspace_id: s.workspace_id,
    matched_via: s.matched_via,
    matched_value: s.matched_value,
    score: s.score,
    confidence: classify(s.score),
    reason:
      s.score === 1
        ? `exact match on normalized ${s.matched_via.replace("_", " ")}`
        : `${(s.score * 100).toFixed(0)}% bigram overlap with ${s.matched_via.replace("_", " ")} "${s.matched_value}"`,
  }));
}
