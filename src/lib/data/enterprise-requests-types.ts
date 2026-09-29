/**
 * Enterprise Request Loop — client-safe types.
 *
 * Split from the server-only store (`enterprise-requests.ts`) so that
 * React client components can `import type { EnterpriseRequestRow }`
 * without pulling in `kvGet` / `runNativeQuery` at bundle time.
 * Same pattern as `admin-flags-types.ts` vs `admin-flags.ts` and
 * `wins-types.ts` vs `wins.ts`.
 */

/** Linear issue state buckets we care about for the customer profile
 *  render. Linear's own `state.type` values are:
 *    `triage` | `unstarted` | `started` | `backlog` | `completed` | `canceled`
 *  We map those + our derived shipped-detection layer into 5 buckets
 *  the CSM actually reasons about. See the promotion state machine
 *  in `enterprise-requests-shipped-sweep.ts` for the transitions. */
/**
 * The bucket the UI renders a request in.
 *
 * These deliberately MIRROR Linear's own state-type taxonomy rather
 * than inventing a parallel vocabulary. The earlier model had its own
 * words ("Open", "Live", "Live, possibly in beta") and tried to infer
 * the shipped ones from Slack; in practice that inference almost never
 * fired, so nearly every delivered request sat in the wrong bucket.
 *
 * Linear is now the single source of truth for WHERE a request is.
 * Whether we also found it in #devs-shipped is recorded separately, as
 * a yes/no on the row (`devs_shipped_match`) — a corroborating fact
 * shown next to the state, not a gate in front of it.
 *
 * One-to-one with `linearStateToDerived` below; there are exactly as
 * many buckets as Linear has state types.
 */
export type EnterpriseRequestDerivedState =
  | "Triage"
  | "Backlog"
  | "Todo"
  | "In progress"
  | "Done (live in app)"
  | "Canceled"
  | "Duplicate";

/** The one state that means the customer can use it. Everything that
 *  asks "is this live?" reads this constant rather than a literal, so
 *  the name can change in one place. */
export const LIVE_STATE: EnterpriseRequestDerivedState = "Done (live in app)";

/** States that mean the request will not be delivered as asked. Used
 *  to keep dead requests out of "outstanding" counts. */
export const CLOSED_STATES: ReadonlySet<EnterpriseRequestDerivedState> =
  new Set<EnterpriseRequestDerivedState>(["Canceled", "Duplicate"]);

/** One-of the fixed Customer Impact labels enforced by Juliet's
 *  `feature-request-creator` skill. `null` when a ticket predates the
 *  skill or the label wasn't applied. Weighted per PDF:
 *    Churn Risk 1.0  ·  Blocking 0.6  ·  Friction 0.3  ·  Nice to have 0.1
 *  Weights only matter for the deferred portfolio ranking view; the
 *  per-customer render only surfaces the label text. */
export type CustomerImpactLabel =
  | "Churn Risk"
  | "Blocking"
  | "Friction"
  | "Nice to have";

/** Type of Work label — mirrors the Sybill/Juliet intake. */
export type WorkTypeLabel = "Bug" | "Feature" | "UI/UX Improvement";

/** How a row got promoted to a shipped state. Persisted alongside the
 *  row so a CSM can eyeball why we're calling something Live rather
 *  than trusting the label blind. */
export type PromotionSource =
  | "devs_shipped" // Matched a linear.app/beehiiv/issue/<KEY> URL in #devs-shipped
  | "changelog" // Exact link match in #topic-product-changelog Resources/links
  | "changelog_fuzzy" // Fuzzy match on name + description in the changelog
  | "linear_state" // Linear state → Dismissed/Canceled (→ Not planned)
  | "manual"; // CSM/admin manually stamped via the exception queue

/**
 * How much we'd stake a customer conversation on a promotion.
 * Deliberately separate from `derived_state`: the state is what we
 * BELIEVE shipped, the confidence is whether we're willing to tell a
 * CSM to go tell their customer about it.
 *
 * Only `confirmed` rows reach the weekly digest DM. `needs_review`
 * rows still render on the customer profile (the signal is real and
 * useful context) but never get pushed at a CSM until a human
 * confirms them from the exceptions queue.
 *
 * The asymmetry is intentional: a false negative costs a CSM a week
 * of latency on good news. A false positive has them tell a customer
 * "your request shipped" about something still behind a flag — which
 * burns trust we can't cheaply rebuild.
 *
 * Confirmed requires an unambiguous signal:
 *   • an exact linear.app link in a #topic-product-changelog post
 *     (the changelog IS the customer-facing release note), or
 *   • a #devs-shipped hit on a ticket Linear labels Bug or
 *     UI/UX Improvement (those ship straight to production — there's
 *     no beta-flag rollout stage for a bugfix).
 *
 * Everything else is needs_review — see `decidePromotion`.
 */
export type PromotionConfidence = "confirmed" | "needs_review";

/** Why a promotion landed in `needs_review`. Rendered verbatim in the
 *  exceptions queue so a reviewer knows what to go check, rather than
 *  re-deriving it from source + work_type. */
export type NeedsReviewReason =
  /** Feature seen only in #devs-shipped. Merged ≠ released: features
   *  routinely sit behind a flag until the changelog post goes out. */
  | "feature_awaiting_changelog"
  /** Neither Linear's work_type label nor the #devs-shipped ship
   *  parens resolved to Bug / UI-UX / Feature. We don't know what
   *  this is, so we don't know whether "merged" means "customer can
   *  see it". */
  | "unresolved_work_type"
  /** Changelog matched on feature name + description similarity
   *  rather than an exact Linear link. Good enough to surface, not
   *  good enough to notify on. */
  | "changelog_fuzzy_match";

/** Where a row entered the snapshot. Rows from the nightly Linear
 *  sync are "customer_needs" — the canonical path. Rows we picked up
 *  from a Slack post in #enterprise-bugs-and-feature-requests that
 *  matched a customer signal + Linear URL are "slack_intake" — these
 *  fill the gap where a CSM posted about a request in Slack but
 *  didn't attach a customer_need in Linear. The two paths reconcile
 *  on subsequent syncs: if a customer_need shows up later, the
 *  Linear sync overwrites the slack_intake row with the full
 *  customer-needs metadata (keeping the slack_intake block intact
 *  as extra context — see runEnterpriseRequestsSync's prior-row
 *  merge). */
export type IntakeSource =
  | "customer_needs"
  | "slack_intake"
  /** Rows discovered by the Linear-comment-scan sweep: an open
   *  Linear issue carried a comment (typically written by Juliet's
   *  feature-request-creator skill) that named a customer via
   *  Publication ID / User Email but never got a formal
   *  customer_need attach. Reconciled the same way as slack_intake:
   *  when a customer_need shows up on the same issue, the Linear
   *  sync overwrites the row with the canonical customer_needs
   *  metadata but preserves the linear_comment block for context. */
  | "linear_comment";

/** Slack-post metadata for a row that either originated from or is
 *  additionally referenced in #enterprise-bugs-and-feature-requests.
 *  Displayed on the profile Requests row as a "Discussed on Slack ↗"
 *  jump link. */
export interface SlackIntakeMeta {
  channel_id: string;
  ts: string;
  permalink: string | null;
  submitter_email: string | null;
  submitter_slack_id: string | null;
  posted_at: string;
  body_preview: string;
  /** How the message resolved to this workspace — publication_id
   *  (`pub_<uuid>` or bare UUID after "Publication ID:"), owner
   *  email from a `User Email:` field, or a `mailto:` link. Kept
   *  around so the admin queue can eyeball a mis-match. */
  matched_via: "publication_id" | "owner_email" | "domain";
}

export interface PromotionHistoryEntry {
  from_state: EnterpriseRequestDerivedState;
  to_state: EnterpriseRequestDerivedState;
  source: PromotionSource;
  at: string;
  permalink?: string | null;
}

/** A single Linear request as it applies to ONE customer. The same
 *  Linear issue can attach to N customer_needs; we fan out to one
 *  row per (workspace_id, linear_issue_id) so the profile render is
 *  a straight lookup and the aggregate-ARR math on the deferred
 *  portfolio view stays a plain sum. */
export interface EnterpriseRequestRow {
  linear_issue_id: string;
  linear_identifier: string; // e.g. "REQ-2207"
  title: string;
  url: string;
  /** Raw Linear state name (e.g. "Triage", "In Review"). Preserved
   *  for the audit trail; the UI reads `derived_state`. */
  linear_state_name: string;
  /** Raw Linear state.type — one of triage/unstarted/started/backlog
   *  /completed/canceled. Powers the "Has open Linear FR" filter chip. */
  linear_state_type: string;
  /** Bucket the UI actually renders. Starts as a mapping of the
   *  Linear state; promoted by the shipped-sweep engine. */
  derived_state: EnterpriseRequestDerivedState;
  work_type: WorkTypeLabel | null;
  customer_impact: CustomerImpactLabel | null;
  /** Whether the ticket carries the `Resurfaced` label — flagged in
   *  the row so the digest can surface "This came back around; the
   *  same customer asked again." */
  resurfaced: boolean;
  /** Linear's native `estimate` numeric field. XS=1 / S=2 / M=3 /
   *  L=5 / XL=8 (T-shirt table from Nicholai). `null` when the field
   *  isn't populated. */
  estimate: number | null;
  project_name: string | null;
  /** Direct link to the Linear project page. Populated when the
   *  ticket has a project; used by the profile UI for the project
   *  chip. Null on tickets not under a project. */
  project_url?: string | null;
  /** Linear ProjectStatusType — one of `backlog` / `planned` /
   *  `started` / `paused` / `completed` / `canceled`. The
   *  shipped-sweep gates "Live" promotion on this being `completed`:
   *  a ticket shipping while its wider project is still in progress
   *  produces a `pending_ship` block instead. Null for tickets not
   *  attached to any project. */
  project_status_type?: string | null;
  linear_completed_at: string | null;
  /** When the customer_need was created (i.e. when this CSM logged
   *  the request against this customer). */
  submitted_at: string;
  submitting_csm_email: string | null;
  /** ARR snapshot at the moment of the sweep. Frozen so the digest
   *  and the ranking view stay stable across refreshes even if
   *  Metabase's MRR shifts mid-day. */
  arr_snapshot: number | null;
  /**
   * Did the shipped-sweep match this ticket to a release post in
   * #devs-shipped? Plain yes/no.
   *
   * This does NOT decide the row's state — Linear does. It answers a
   * different question: "has this ticket's code actually gone out in a
   * deploy we can point at?" A request can be `Done (live in app)` in
   * Linear with no match here (shipped as part of a project whose
   * individual tickets weren't listed, or shipped before we started
   * watching), and it can have a match here while Linear still says
   * In progress (merged, not yet marked done).
   *
   * Optional because rows written before this field existed don't
   * carry it — read every row through `hasDevsShippedMatch()`, which
   * back-derives from `promotion_source` rather than assuming false.
   */
  devs_shipped_match?: boolean;
  /** Permalink to the #devs-shipped release post that matched. Null
   *  when the match predates permalink capture or Slack refused it. */
  devs_shipped_url?: string | null;
  /** When that release post went out (from the Slack `ts`, which is
   *  always a reliable epoch — unlike the human "Deployed by …" line). */
  devs_shipped_at?: string | null;
  /** Ship metadata — populated by the shipped-sweep engine. */
  promotion_source: PromotionSource | null;
  promoted_at: string | null;
  ship_url: string | null;
  ship_date: string | null;
  promotion_history: PromotionHistoryEntry[];
  /** Whether this promotion is trustworthy enough to DM a CSM about.
   *  Optional because rows promoted before the confidence model
   *  existed don't carry it — read those through
   *  `resolveConfidence()`, which back-derives the value from
   *  promotion_source + work_type rather than defaulting blindly. */
  promotion_confidence?: PromotionConfidence | null;
  /** Why the row needs review. Only meaningful when
   *  `promotion_confidence === "needs_review"`. */
  needs_review_reason?: NeedsReviewReason | null;
  /** Set when a human cleared the row out of the exceptions queue —
   *  either confirming the ship (confidence flips to `confirmed`,
   *  making it digest-eligible) or dismissing it as not customer-
   *  facing. */
  review?: {
    decided_at: string;
    decided_by: string;
    decision: "confirmed" | "dismissed";
    note?: string | null;
  } | null;
  /** How this row entered the snapshot. Absent on rows that predate
   *  the slack-intake sweep — those default to "customer_needs" on
   *  read for backward compatibility. */
  intake_source?: IntakeSource;
  /** Optional link back to the Slack post that mentioned this
   *  request. Populated when the slack-intake sweep finds a match;
   *  never cleared by the Linear sync (the sync merges this block
   *  forward from the prior snapshot). */
  slack_intake?: SlackIntakeMeta | null;
  /** Optional link back to the Linear comment that mentioned this
   *  customer. Populated by the linear-comment-scan sweep. Same
   *  merge posture as slack_intake — customer_needs sync preserves
   *  the block across runs. */
  linear_comment?: LinearCommentMeta | null;
  /** Set when the shipped-sweep saw a Slack ship hit for this row
   *  but the parent project's status.type is still not `completed`.
   *  We capture the intended promotion in this block instead of
   *  updating `derived_state` so the CSM isn't told the customer
   *  received the feature before the project is actually released.
   *
   *  @deprecated Nothing writes or reads this any more. It existed
   *  because a Slack hit was being used to claim a row was Live, and
   *  a single ticket shipping out of an unfinished project is a bad
   *  reason to make that claim. Linear owns the state now, so there
   *  is no promotion to defer. Kept on the interface only so blobs
   *  written before the change still type-check on read; drop it once
   *  a full sync has rewritten every row. */
  pending_ship?: PendingShip | null;
}

/** @deprecated See `pending_ship` above — retired with the move to
 *  Linear-owned state. Retained for read-compatibility only.
 *
 *  Deferred-promotion payload: what the shipped-sweep WOULD have
 *  promoted the row to if the parent project were already
 *  `completed`. Captured 1:1 with the shipped-sweep's decision so
 *  the deferred pass can apply it verbatim without re-computing
 *  from Slack. */
export interface PendingShip {
  target_state: EnterpriseRequestDerivedState;
  source: PromotionSource;
  ship_url: string | null;
  ship_date: string | null;
  detected_at: string;
  /** Carried through from the shipped-sweep's decision so the
   *  deferred pass applies the same confidence it would have at
   *  detection time. Optional for blobs written before the
   *  confidence model — those resolve via `resolveConfidence()`. */
  confidence?: PromotionConfidence;
  needs_review_reason?: NeedsReviewReason | null;
  /** Snapshot of the project state at detection time — surfaced in
   *  the UI badge so a CSM can see "shipped, waiting on project X"
   *  without a second Linear round-trip. */
  project_name: string | null;
  project_status_type: string | null;
}

/** Linear-comment metadata for a row discovered via
 *  `enterprise-requests-linear-comment-scan`. Stored on the row so
 *  the profile UI can deep-link back to the exact comment that
 *  triggered the association. */
export interface LinearCommentMeta {
  issue_id: string;
  issue_identifier: string;
  /** Where on the ticket the customer signal was found.
   *
   *  "comment" — the original path: a comment (typically from
   *  Juliet's feature-request-creator skill) naming a Publication ID
   *  or User Email.
   *
   *  "description" — the same structured block written into the
   *  issue body instead of a comment. Added after BEE-24879 shipped
   *  for Daily Drop without ever reaching the tracker: it carried a
   *  perfectly parseable `Publication ID` / `User Email` block, just
   *  in the description, which nothing read. Absent on rows written
   *  before the description pass existed — treat undefined as
   *  "comment". */
  source?: "comment" | "description";
  /** Null for description matches — there's no comment to anchor to. */
  comment_id: string | null;
  /** Direct URL to the comment (issue URL + `#comment-<id>` fragment).
   *  Linear renders this as a scroll-to-anchor. For a description
   *  match this is the plain issue URL. */
  permalink: string;
  /** Comment author email (available on the Linear comment.user
   *  relation); for a description match, the issue creator. Kept for
   *  the profile display + admin audit. */
  author_email: string | null;
  author_name: string | null;
  posted_at: string;
  body_preview: string;
  matched_via: "publication_id" | "owner_email" | "domain";
}

/** A Linear customer that couldn't be resolved to a dash workspace.
 *  Powers the admin queue at /settings/enterprise-requests/unmatched. */
export interface UnmatchedNeed {
  linear_customer_id: string;
  linear_customer_name: string;
  external_ids: string[];
  domains: string[];
  need_id: string;
  need_body: string;
  first_seen_at: string;
}

export interface EnterpriseRequestsBlob {
  /** Bucketed by workspace_id so per-customer render is one lookup.
   *  Inner key is `linear_issue_id`. */
  rows: Record<string, Record<string, EnterpriseRequestRow>>;
  /** Linear customers we couldn't match — surfaced in the admin
   *  queue. Cleared each run and re-populated so a manual mapping
   *  taking effect drops the row out organically. */
  unmatched: UnmatchedNeed[];
  fetched_at: string;
  /** Rough summary counters for the sync's own logging. */
  last_run: {
    pulled: number;
    matched: number;
    unmatched: number;
  } | null;
}

/** Per-(workspace, issue) notified state. Two fields so the queue can
 *  distinguish "CSM opened the outreach draft" from "CSM confirmed
 *  they sent it." A row with only `drafted_at` still appears on the
 *  action queue as pending. */
export interface NotifiedEntry {
  drafted_at?: string | null;
  drafted_by?: string | null;
  notified_at?: string | null;
  notified_by?: string | null;
}

export interface NotifiedBlob {
  /** `Record<workspace_id, Record<linear_issue_id, NotifiedEntry>>`. */
  rows: Record<string, Record<string, NotifiedEntry>>;
  updated_at: string;
}

/** Admin-approved manual mappings from a Linear customer to a
 *  workspace_id. Consulted first by the sync engine's matcher, before
 *  the three-strike externalIds/domains fall-through. */
export interface ManualMap {
  /** `Record<linear_customer_id, workspace_id | "__skipped">`.
   *  `"__skipped"` means the admin explicitly said "this Linear
   *  customer isn't a dash customer — stop asking me." The sync
   *  drops it from the unmatched queue on subsequent runs. */
  by_linear_customer_id: Record<string, string>;
  updated_at: string;
}

/** Per-channel cursor for the shipped-sweep engine. Keeps track of
 *  the newest Slack `ts` we've processed in each source channel so
 *  the next run only pulls fresh messages. */
export interface ShippedCursorBlob {
  devs_shipped_ts: string | null;
  changelog_ts: string | null;
  updated_at: string;
}

/** Cursor blob for the #enterprise-bugs-and-feature-requests intake
 *  sweep. Separate from the shipped cursor because the two sweeps
 *  can run at different cadences (the intake sweep is idempotent
 *  and re-reads for annotations even on already-processed messages
 *  when a new Linear ticket URL gets edited into an existing post,
 *  so the cursor is a soft floor not a hard barrier). */
export interface SlackIntakeCursorBlob {
  intake_ts: string | null;
  updated_at: string;
}

/** Cursor blob for the Linear-comment-scan sweep. Stores an ISO
 *  timestamp — the sweep filters open issues by `updatedAt >
 *  scan_after` on incremental runs. `backfill: true` on the engine
 *  ignores the cursor and re-walks every open issue. */
export interface LinearCommentScanCursorBlob {
  scan_after: string | null;
  updated_at: string;
}

/** Shipped-channel hits that couldn't match to any snapshot row after
 *  the 14-day grace window. Powers the orphans admin queue. */
export interface OrphanedShipment {
  source_channel: "devs_shipped" | "changelog";
  ship_permalink: string;
  ship_ts: string; // Slack ts
  linear_key: string | null; // Extracted linear.app URL fragment, if any
  feature_name: string | null; // Changelog "Feature Name" if any
  first_seen_at: string;
  status: "pending" | "not_customer_facing" | "dismissed";
  dismissed_by?: string | null;
  dismissed_at?: string | null;
}

export interface OrphanedShipmentsBlob {
  orphans: Record<string, OrphanedShipment>; // keyed by ship_permalink
  updated_at: string;
}

/** Dedupe row for the weekly Slack DM. Guarantees "one ping per
 *  shipped request per CSM" even across re-runs of the digest. */
export interface DigestSentBlob {
  /** `Record<csm_email, Record<linear_issue_id, sent_at>>`. */
  sent: Record<string, Record<string, string>>;
  updated_at: string;
}

// ─── Derivation helpers (pure, reusable server + client) ─────────

/** Map a Linear state.type onto the derived bucket the UI renders.
 *  Used at sync time to seed each row's `derived_state`; the shipped
 *  sweep can then promote from here. `unknown` state types fall
 *  through to `Open` so a new Linear state doesn't crash the render. */
export function linearStateToDerived(
  stateType: string
): EnterpriseRequestDerivedState {
  switch (stateType) {
    case "triage":
      return "Triage";
    case "backlog":
      return "Backlog";
    case "unstarted":
      return "Todo";
    case "started":
      return "In progress";
    case "completed":
      // Linear's REQ team names this state "Done (live in app)" — an
      // explicit human assertion that the customer can see it. We take
      // it at face value. The previous model refused to, held every
      // completed ticket at "In progress", and waited on a Slack
      // signal that essentially never arrived.
      return "Done (live in app)";
    case "canceled":
      return "Canceled";
    case "duplicate":
      // Linear's 7th state type. It had no case here, so duplicates
      // fell through `default` and rendered as open requests forever.
      return "Duplicate";
    default:
      // An unrecognized type is a Linear change we haven't seen. Land
      // it in Triage so it shows up as needing a human look rather
      // than silently claiming to be delivered.
      return "Triage";
  }
}

/** Terminal states the "Has open Linear FR" filter chip excludes. */
export const OPEN_STATE_TYPES = new Set([
  "triage",
  "backlog",
  "unstarted",
  "started",
]);

/** Map Linear's integer `estimate` back to a T-shirt string for the
 *  Requests table. Nicholai's confirmed scale: XS=1 / S=2 / M=3 /
 *  L=5 / XL=8. Anything unmapped renders "—" via the fallback. */
export function estimateToTShirt(estimate: number | null): string | null {
  if (estimate == null) return null;
  switch (estimate) {
    case 1:
      return "XS";
    case 2:
      return "S";
    case 3:
      return "M";
    case 5:
      return "L";
    case 8:
      return "XL";
    default:
      return null;
  }
}

/**
 * Read a row's promotion confidence, back-deriving it for rows that
 * predate the confidence model.
 *
 * Legacy rows (promoted before `promotion_confidence` existed) carry
 * the field as undefined. Defaulting those to `confirmed` would
 * preserve exactly the false positives the model exists to stop;
 * defaulting to `needs_review` would dump every already-notified row
 * into the exceptions queue. So instead we re-derive what the current
 * rules WOULD have decided from the fields the row already has:
 *
 *   • exact changelog match  → confirmed (unambiguous then and now)
 *   • devs_shipped + Bug / UI-UX → confirmed
 *   • anything else → needs_review
 *
 * `linear_state` promotions (→ Not planned) are confirmed: a canceled
 * Linear ticket is a fact, not an inference, and the digest doesn't
 * DM on them anyway.
 */
export function resolveConfidence(
  row: Pick<
    EnterpriseRequestRow,
    | "promotion_confidence"
    | "promotion_source"
    | "work_type"
    | "devs_shipped_match"
    | "review"
  >
): PromotionConfidence {
  // A human decision outranks everything.
  if (row.review?.decision === "confirmed") return "confirmed";
  if (row.promotion_confidence) return row.promotion_confidence;
  return hasDevsShippedMatch(row) ? "confirmed" : "needs_review";
}

/**
 * Did we match this ticket to a #devs-shipped release post?
 *
 * Reads the explicit flag when the row carries one. Rows written
 * before the flag existed don't, so we back-derive: the only way a row
 * got `promotion_source: "devs_shipped"` under the old engine was by
 * matching that channel, which is exactly what this asks. Anything
 * else (changelog, linear_state, manual, or never promoted) is a "no".
 *
 * Kept as a function rather than read as a raw boolean so that
 * back-derivation lives in one place — a bare `row.devs_shipped_match`
 * silently reports "no" for every pre-existing row.
 */
export function hasDevsShippedMatch(
  row: Pick<EnterpriseRequestRow, "devs_shipped_match" | "promotion_source">
): boolean {
  if (typeof row.devs_shipped_match === "boolean") {
    return row.devs_shipped_match;
  }
  return row.promotion_source === "devs_shipped";
}

/** Is the customer able to use this today, per Linear? */
export function isLive(
  row: Pick<EnterpriseRequestRow, "derived_state">
): boolean {
  return row.derived_state === LIVE_STATE;
}

/**
 * When the request went live, for windowing ("shipped this week").
 *
 * `linear_completed_at` is the moment someone moved the ticket into a
 * completed state, which under the new model IS the live moment. Falls
 * back to the Slack-derived `promoted_at` for rows that were promoted
 * by the old engine and never re-synced, so the Live requests tab
 * doesn't lose its existing history the day this ships.
 */
export function liveAt(
  row: Pick<EnterpriseRequestRow, "linear_completed_at" | "promoted_at">
): string | null {
  return row.linear_completed_at ?? row.promoted_at ?? null;
}
