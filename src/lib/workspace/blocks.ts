import type { Customer } from "@/lib/types";
import { lastContacted, subUtilFraction } from "@/lib/customer-helpers";

/**
 * Which blocks are true about an account today.
 *
 * This is the whole premise of the Workspace layout: the screen's
 * content is proportional to what's actually happening, rather than a
 * fixed grid of panels that are mostly empty. A quiet account renders
 * two blocks. An account in trouble fills the page.
 *
 * The inversion that makes it work is `absent` — every block that
 * DIDN'T qualify comes back with the reason it didn't. Without that,
 * a layout that changes per account is just unpredictable: you can't
 * tell "no deliverability problem" from "deliverability isn't wired
 * up on this screen". Naming the absence is what makes a missing
 * block informative instead of suspicious.
 *
 * Pure — a Customer plus a few already-fetched counts. No KV, no
 * engines, no fetches, so it can run on every keystroke of the
 * account filter without a round-trip.
 */

export type BlockId =
  | "renewal"
  | "silence"
  | "sends"
  | "utilization"
  | "requests"
  | "support"
  | "people";

export type Tone = "urgent" | "watch" | "calm";

export interface BlockVerdict {
  id: BlockId;
  label: string;
  /** The headline fact, in a few words — rendered next to the label. */
  fact: string;
  /** A sentence of context. This is what a CSM reads instead of
   *  interpreting a number themselves. */
  detail: string;
  tone: Tone;
  /** Columns out of 6. Urgent blocks get width because they carry
   *  more words; calm ones stay narrow so several fit a row. */
  span: number;
}

export interface AbsentBlock {
  id: BlockId;
  label: string;
  /** Why it isn't on screen. Always a positive statement of fact —
   *  "no tickets in 30 days", never "no data". */
  why: string;
}

export interface BlockInput {
  customer: Customer;
  /** Zendesk tickets in the last 30 days, from the overlay. `null`
   *  when the overlay has never been refreshed for this workspace —
   *  which is NOT the same as zero, and is reported as such. */
  zendesk: { total: number; high: number } | null;
  /**
   * Request counts from /api/enterprise-requests/open-workspaces.
   *
   * Three distinct states, because collapsing them mislabels the
   * block: `"disabled"` (viewer can't see the Request Loop),
   * `"pending"` (the fetch hasn't landed — say nothing rather than
   * claim there are none), or the counts themselves. An account with
   * no requests is `{total: 0}`, not null.
   */
  requests:
    | { open: number; shipped: number; total: number }
    | "disabled"
    | "pending";
}

const TONE_RANK: Record<Tone, number> = { urgent: 0, watch: 1, calm: 2 };

const DAY_MS = 24 * 60 * 60 * 1000;

function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor((ms - Date.now()) / DAY_MS);
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  // Clamp at 0. A send stamped a few hours ahead of the server clock
  // floors to -1, which renders as "sent -1d ago".
  return Math.max(0, Math.floor((Date.now() - ms) / DAY_MS));
}

/** Days we'd expect between sends: the CSM's pinned override, else
 *  what the cadence sweep inferred, else a fortnight. */
function expectedCadence(c: Customer): number {
  return c.expected_send_cadence_days ?? c.inferred_cadence_days ?? 14;
}

export interface BlockPlan {
  live: BlockVerdict[];
  absent: AbsentBlock[];
}

export function decideBlocks(input: BlockInput): BlockPlan {
  const { customer: c, zendesk, requests } = input;
  const live: BlockVerdict[] = [];
  const absent: AbsentBlock[] = [];

  // ── Renewal ──────────────────────────────────────────────────────
  const renewIn = daysUntil(c.renewal_date);
  const quietFor = daysSince(lastContacted(c).date);
  if (renewIn !== null && renewIn < 0) {
    live.push({
      id: "renewal",
      label: "Renewal",
      fact: `${Math.abs(renewIn)} days overdue`,
      detail:
        "The renewal date has passed with nothing recorded against it. Either it renewed and nobody updated the record, or it didn't.",
      tone: "urgent",
      span: 4,
    });
  } else if (renewIn !== null && renewIn <= 30) {
    live.push({
      id: "renewal",
      label: "Renewal",
      fact: `${renewIn} days`,
      detail:
        quietFor !== null && quietFor >= 30
          ? `Inside a month, and the last contact of any kind was ${quietFor} days ago.`
          : "Inside a month. Worth confirming the commercials are agreed rather than assumed.",
      tone: "urgent",
      span: 4,
    });
  } else if (renewIn !== null && renewIn <= 90) {
    live.push({
      id: "renewal",
      label: "Renewal",
      fact: `${renewIn} days`,
      detail:
        "Far enough out to plan properly, close enough that a QBR should be on the calendar.",
      tone: "watch",
      span: 3,
    });
  } else {
    absent.push({
      id: "renewal",
      label: "Renewal",
      why:
        renewIn === null
          ? "no renewal date on the record"
          : `${renewIn} days out`,
    });
  }

  // ── Silence ──────────────────────────────────────────────────────
  // Deliberately separate from Renewal even though the renewal block
  // mentions it: silence on an account with no renewal pressure is
  // still the thing most likely to cost you the account.
  if (quietFor === null) {
    live.push({
      id: "silence",
      label: "Contact",
      fact: "nothing on record",
      detail:
        "No Gmail thread, HubSpot activity or note has ever been logged against this account.",
      tone: "watch",
      span: 3,
    });
  } else if (quietFor >= 60) {
    live.push({
      id: "silence",
      label: "Contact",
      fact: `${quietFor} days cold`,
      detail: `Last touch of any kind was ${quietFor} days ago, via ${lastContacted(c).source}.`,
      tone: "urgent",
      span: 3,
    });
  } else if (quietFor >= 30) {
    live.push({
      id: "silence",
      label: "Contact",
      fact: `${quietFor} days`,
      detail: `Last touch was ${quietFor} days ago, via ${lastContacted(c).source}.`,
      tone: "watch",
      span: 3,
    });
  } else {
    absent.push({
      id: "silence",
      label: "Contact",
      why: `spoke ${quietFor} days ago`,
    });
  }

  // ── Sends ────────────────────────────────────────────────────────
  const sinceSend = daysSince(c.last_send);
  const cadence = expectedCadence(c);
  if (sinceSend === null) {
    absent.push({
      id: "sends",
      label: "Sending",
      why: "no send recorded",
    });
  } else if (sinceSend > cadence * 2) {
    live.push({
      id: "sends",
      label: "Sending",
      fact: `${sinceSend} days quiet`,
      detail: `They normally send about every ${cadence} days. A publisher that stops sending is usually the first sign of a problem the CSM hears about last.`,
      tone: "urgent",
      span: 3,
    });
  } else if (sinceSend > cadence) {
    live.push({
      id: "sends",
      label: "Sending",
      fact: `${sinceSend} days`,
      detail: `Past their usual ${cadence}-day rhythm, but not yet by much.`,
      tone: "watch",
      span: 2,
    });
  } else {
    absent.push({
      id: "sends",
      label: "Sending",
      why: `on cadence, sent ${sinceSend}d ago`,
    });
  }

  // ── Utilization ──────────────────────────────────────────────────
  const util = subUtilFraction(c);
  if (util === null) {
    absent.push({
      id: "utilization",
      label: "Subscribers",
      why: "no subscriber ceiling on the plan",
    });
  } else if (util >= 0.9) {
    live.push({
      id: "utilization",
      label: "Subscribers",
      fact: `${Math.round(util * 100)}% of plan`,
      detail:
        "Close enough to the ceiling that an upgrade conversation should happen before they hit it rather than after.",
      tone: "urgent",
      span: 3,
    });
  } else if (util < 0.5) {
    live.push({
      id: "utilization",
      label: "Subscribers",
      fact: `${Math.round(util * 100)}% of plan`,
      detail:
        "They're paying for a lot more room than they're using, which is what a renewal conversation tends to get pointed at.",
      tone: "watch",
      span: 3,
    });
  } else {
    absent.push({
      id: "utilization",
      label: "Subscribers",
      why: `${Math.round(util * 100)}% of plan, comfortable`,
    });
  }

  // ── Requests ─────────────────────────────────────────────────────
  if (requests === "pending") {
    // Say nothing until we know. A block that flickers from "nothing
    // logged" to "3 open" teaches people to distrust it.
  } else if (requests === "disabled") {
    absent.push({
      id: "requests",
      label: "Requests",
      why: "request tracking isn't enabled for you",
    });
  } else if (requests.total === 0) {
    absent.push({
      id: "requests",
      label: "Requests",
      why: "nothing logged in Linear",
    });
  } else {
    const delivered = requests.shipped;
    live.push({
      id: "requests",
      label: "Requests",
      fact:
        delivered > 0
          ? `${requests.open} open · ${delivered} delivered`
          : `${requests.open} open`,
      detail:
        delivered > 0
          ? "Something they asked for has shipped. That's a free reason to be in their inbox."
          : "Asks logged against this account that haven't landed yet.",
      tone: delivered > 0 ? "watch" : "calm",
      span: 3,
    });
  }

  // ── Support ──────────────────────────────────────────────────────
  if (zendesk === null) {
    absent.push({
      id: "support",
      label: "Support",
      why: "ticket overlay hasn't been refreshed for this account",
    });
  } else if (zendesk.total === 0) {
    absent.push({
      id: "support",
      label: "Support",
      why: "no tickets in 30 days",
    });
  } else {
    live.push({
      id: "support",
      label: "Support",
      fact:
        zendesk.high > 0
          ? `${zendesk.total} tickets · ${zendesk.high} high`
          : `${zendesk.total} tickets`,
      detail:
        zendesk.high > 0
          ? "High-priority tickets in the last 30 days. Worth reading before any renewal conversation."
          : "Tickets in the last 30 days, none urgent.",
      tone: zendesk.high > 0 ? "watch" : "calm",
      span: 2,
    });
  }

  // ── People ───────────────────────────────────────────────────────
  const contacts = c.hubspot_contacts ?? [];
  if (contacts.length === 0) {
    absent.push({
      id: "people",
      label: "People",
      why: "no contacts synced from HubSpot",
    });
  } else {
    live.push({
      id: "people",
      label: "People",
      fact: `${contacts.length} contact${contacts.length === 1 ? "" : "s"}`,
      detail: "Who to write to, and who has gone quiet.",
      tone: "calm",
      span: 3,
    });
  }

  live.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || b.span - a.span);
  return { live, absent };
}

/** One-line summary for the account header: how much is going on. */
export function summarize(plan: BlockPlan): string {
  const urgent = plan.live.filter((b) => b.tone === "urgent").length;
  if (urgent > 0) {
    return `${urgent} thing${urgent === 1 ? "" : "s"} need${urgent === 1 ? "s" : ""} attention`;
  }
  if (plan.live.length === 0) return "Nothing to report today";
  return `${plan.live.length} thing${plan.live.length === 1 ? "" : "s"} worth knowing`;
}

/** Worst tone across the live blocks — drives the rail dot. */
export function accountTone(plan: BlockPlan): Tone {
  if (plan.live.some((b) => b.tone === "urgent")) return "urgent";
  if (plan.live.some((b) => b.tone === "watch")) return "watch";
  return "calm";
}
