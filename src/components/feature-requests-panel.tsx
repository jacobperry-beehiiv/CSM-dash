"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtDate } from "./format";
import { useViewerEmail } from "@/lib/auth-client";
import {
  newRequestId,
  sortRequests,
  PRIORITY_LABEL,
  STATUS_LABEL,
  TEAM_LABEL,
  type FeatureRequest,
  type FeatureRequestOp,
  type FeatureRequestPriority,
  type FeatureRequestStatus,
  type FeatureRequestTeam,
} from "@/lib/feature-requests/types";

/**
 * Feature-request board UI.
 *
 *   - Inline composer at the top (description / CSM-AM / priority).
 *   - List ordered by manual rank, with ties broken by votes desc.
 *   - Per-row Vote button toggles the viewer's vote in/out.
 *   - ↑ / ↓ arrows reorder a row within the list.
 *   - Each row has an inline editor (description / priority / status)
 *     plus a delete button. Permissions are intentionally relaxed —
 *     anyone signed-in can edit anything, mirroring team-tasks.
 *   - Background poll every 20s so votes / reorders from teammates
 *     show up without a manual refresh.
 *
 * Network model is the same atomic-ops PATCH pattern as
 * personal-todos / team-tasks: every mutation lands as a discrete op,
 * the server reads-applies-writes against the latest snapshot, and
 * concurrent edits merge instead of stomping each other.
 *
 * Optimistic local updates keep the UI feeling instant; failed
 * server responses surface a small banner so the user knows a write
 * dropped on the floor.
 */

const CSM_PRESETS = [
  "Jacob Perry",
  "Olivia Chen",
  "Mac",
  "Hayden",
  "Mik",
  "Chris",
  "Jess",
  "Luke",
];

export function FeatureRequestsPanel() {
  const viewerEmail = useViewerEmail();
  const [requests, setRequests] = useState<FeatureRequest[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  // Composer state.
  const [draftDescription, setDraftDescription] = useState("");
  const [draftSubmitter, setDraftSubmitter] = useState("");
  const [draftTeam, setDraftTeam] = useState<FeatureRequestTeam>("csm");
  const [draftPriority, setDraftPriority] =
    useState<FeatureRequestPriority>("medium");
  const [submitting, setSubmitting] = useState(false);

  // Filter tabs above the list. "all" is the default so the board
  // still reads as a single shared backlog at a glance; the CSM/AM
  // tabs are for when you want to focus on your team's asks.
  const [teamFilter, setTeamFilter] = useState<FeatureRequestTeam | "all">(
    "all"
  );

  // Per-request inline-edit state. Keyed by request id; absence means
  // not-editing. Stores draft text so a typo doesn't fire a network
  // request on every keystroke — we commit on Save click.
  const [editing, setEditing] = useState<
    Record<string, { description: string }>
  >({});
  // Inline delete confirm — window.confirm() is silently blocked in
  // some embedded browsers, which made Delete look broken.
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  // Per-request comment composer — keyed by request id when open.
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>(
    {}
  );
  const [commentBusyId, setCommentBusyId] = useState<string | null>(null);
  const [commentFeedback, setCommentFeedback] = useState<string | null>(null);

  // ── Load + poll ──
  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/feature-requests");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = (await r.json()) as { requests: FeatureRequest[] };
      setRequests(json.requests);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(refresh, 20_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  // Default the composer's submitter field to the viewer's CSM name
  // (best-effort — falls back to the email prefix when we don't have
  // a humanized version). Doesn't overwrite manual edits.
  useEffect(() => {
    if (draftSubmitter) return;
    if (!viewerEmail) return;
    const prefix = viewerEmail.split("@")[0] ?? "";
    const guess = prefix
      .split(".")
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(" ");
    setDraftSubmitter(guess);
  }, [viewerEmail, draftSubmitter]);

  // ── Server-talking helper ──
  const sendOps = useCallback(
    async (
      ops: FeatureRequestOp[]
    ): Promise<{
      ok: boolean;
      commentFollowUp?: {
        slack: { sent: boolean; reason?: string };
        todo: { added: boolean; reason?: string };
      } | null;
    }> => {
      try {
        const r = await fetch("/api/feature-requests", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ops }),
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        const json = (await r.json()) as {
          requests: FeatureRequest[];
          comment_follow_up?: {
            slack: { sent: boolean; reason?: string };
            todo: { added: boolean; reason?: string };
          } | null;
        };
        setRequests(json.requests);
        setWriteError(null);
        return {
          ok: true,
          commentFollowUp: json.comment_follow_up ?? null,
        };
      } catch (e) {
        setWriteError(e instanceof Error ? e.message : "Save failed");
        // Bring local state back into sync with the server so a
        // failed optimistic update doesn't linger as a phantom row.
        void refresh();
        return { ok: false };
      }
    },
    [refresh]
  );

  // ── Composer ──
  async function addFromComposer() {
    const description = draftDescription.trim();
    if (!description) return;
    if (!viewerEmail) return;
    const submitter =
      draftSubmitter.trim() || viewerEmail.split("@")[0] || "Anonymous";
    setSubmitting(true);
    const now = new Date().toISOString();
    const request: FeatureRequest = {
      id: newRequestId(),
      description,
      submitter,
      submitter_email: viewerEmail,
      team: draftTeam,
      priority: draftPriority,
      status: "open",
      votes: [],
      rank: 999_999, // placeholder; server reassigns to current max+1
      created_at: now,
      updated_at: now,
    };
    // Optimistic insert at the bottom so the user sees their entry
    // immediately. Server response replaces this with the canonical
    // list (with the real rank applied).
    setRequests((prev) => (prev ? [...prev, request] : [request]));
    const { ok } = await sendOps([{ type: "add", request }]);
    if (ok) {
      setDraftDescription("");
      setDraftPriority("medium");
      // Keep the submitter field — most users will file several in a
      // row under the same name.
    }
    setSubmitting(false);
  }

  // ── Voting ──
  async function toggleVote(req: FeatureRequest) {
    if (!viewerEmail) return;
    const me = viewerEmail.toLowerCase();
    const hasVoted = req.votes.includes(me);
    // Optimistic vote toggle for snappy feedback.
    setRequests((prev) =>
      prev
        ? prev.map((r) =>
            r.id !== req.id
              ? r
              : {
                  ...r,
                  votes: hasVoted
                    ? r.votes.filter((v) => v !== me)
                    : [...r.votes, me],
                }
          )
        : prev
    );
    void sendOps([
      {
        type: hasVoted ? "unvote" : "vote",
        requestId: req.id,
        voterEmail: me,
      },
    ]);
  }

  // ── Reorder ──
  /** Move a request up or down by one slot in the sorted order. The
   *  server snaps every other row to match (rank = index) so a
   *  partial reorder doesn't leave gaps. */
  async function moveRequest(req: FeatureRequest, direction: "up" | "down") {
    if (!requests) return;
    const sorted = sortRequests(requests);
    const idx = sorted.findIndex((r) => r.id === req.id);
    if (idx < 0) return;
    const swapWith = direction === "up" ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= sorted.length) return;
    const next = sorted.slice();
    const [moved] = next.splice(idx, 1);
    next.splice(swapWith, 0, moved);
    // Optimistic local reorder via rank field.
    const orderedIds = next.map((r) => r.id);
    setRequests((prev) =>
      prev
        ? prev.map((r) => {
            const rank = orderedIds.indexOf(r.id);
            return rank < 0 ? r : { ...r, rank };
          })
        : prev
    );
    void sendOps([{ type: "reorder", orderedIds }]);
  }

  // ── Per-row patches (priority, status, description) ──
  async function patchRequest(
    id: string,
    patch: Partial<
      Pick<
        FeatureRequest,
        "description" | "priority" | "status" | "submitter" | "team"
      >
    >
  ) {
    setRequests((prev) =>
      prev
        ? prev.map((r) =>
            r.id !== id ? r : { ...r, ...patch, updated_at: new Date().toISOString() }
          )
        : prev
    );
    void sendOps([{ type: "patch", requestId: id, patch }]);
  }

  async function postComment(requestId: string) {
    const body = (commentDrafts[requestId] ?? "").trim();
    if (!body || !viewerEmail) return;
    setCommentBusyId(requestId);
    const me = viewerEmail.toLowerCase();
    const authorName =
      viewerEmail
        .split("@")[0]
        ?.split(/[._-]/)
        .filter(Boolean)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join(" ") || "Anonymous";
    const optimistic = {
      id: `tmp_${Date.now()}`,
      body,
      author_email: me,
      author_name: authorName,
      created_at: new Date().toISOString(),
    };
    setRequests((prev) =>
      prev
        ? prev.map((r) =>
            r.id !== requestId
              ? r
              : {
                  ...r,
                  comments: [...(r.comments ?? []), optimistic],
                  updated_at: new Date().toISOString(),
                }
          )
        : prev
    );
    const request = requests?.find((r) => r.id === requestId);
    const { ok, commentFollowUp } = await sendOps([
      { type: "comment", requestId, body },
    ]);
    if (ok) {
      setCommentDrafts((prev) => {
        const next = { ...prev };
        delete next[requestId];
        return next;
      });
      if (commentFollowUp) {
        const bits: string[] = ["Comment posted"];
        if (commentFollowUp.slack.sent) {
          bits.push(
            `${request?.submitter ?? "requester"} pinged in Slack`
          );
        }
        if (commentFollowUp.todo.added) {
          bits.push("added to their to-do list");
        }
        if (
          commentFollowUp.slack.reason === "commenter is the submitter" ||
          commentFollowUp.todo.reason === "commenter is the submitter"
        ) {
          setCommentFeedback(
            "Comment posted on your own request (no Slack ping or to-do)."
          );
        } else if (bits.length > 1) {
          setCommentFeedback(bits.join(" · ") + ".");
        } else {
          const reasons = [
            !commentFollowUp.slack.sent && commentFollowUp.slack.reason,
            !commentFollowUp.todo.added && commentFollowUp.todo.reason,
          ].filter((r): r is string => Boolean(r));
          setCommentFeedback(
            reasons.length > 0
              ? `Comment saved, but follow-up failed: ${reasons.join("; ")}`
              : "Comment saved."
          );
        }
        setTimeout(() => setCommentFeedback(null), 8_000);
      }
    }
    setCommentBusyId(null);
  }

  async function deleteRequest(id: string) {
    if (deleteConfirmId !== id) {
      setDeleteConfirmId(id);
      return;
    }
    setDeleteConfirmId(null);
    setRequests((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
    await sendOps([{ type: "delete", requestId: id }]);
  }

  // ── Sorted view + counters ──
  // Sort the full list first so the manual rank is computed against
  // all rows (not just the filtered view) — this keeps a CSM-tab
  // reorder from silently shuffling the AM-tab order.
  const allSorted = useMemo(
    () => (requests ? sortRequests(requests) : []),
    [requests]
  );
  const sortedRequests = useMemo(
    () =>
      teamFilter === "all"
        ? allSorted
        : allSorted.filter((r) => (r.team ?? "csm") === teamFilter),
    [allSorted, teamFilter]
  );
  const openCount = sortedRequests.filter((r) => r.status === "open").length;
  const inProgressCount = sortedRequests.filter(
    (r) => r.status === "in_progress"
  ).length;
  const shippedCount = sortedRequests.filter(
    (r) => r.status === "shipped"
  ).length;
  // Filter-tab counts: total per team across statuses so the tab
  // labels read as a meaningful "how big is each backlog" cue.
  const csmTotal = allSorted.filter((r) => (r.team ?? "csm") === "csm").length;
  const amTotal = allSorted.filter((r) => (r.team ?? "csm") === "am").length;

  return (
    <div className="bg-surface border border-border rounded-xl shadow-card overflow-hidden">
      <header className="px-5 py-3 border-b border-border flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-fg">
            Feature requests
          </h2>
          <p className="text-xs text-muted mt-0.5">
            Submit a request, vote on others, drag-rank the queue.
            Comment on a row to DM the requester in Slack.
          </p>
        </div>
        <div className="ml-auto text-[12px] text-muted">
          {openCount} open · {inProgressCount} in progress · {shippedCount}{" "}
          shipped
        </div>
      </header>

      {/* Composer */}
      <div className="px-5 py-3 bg-canvas/30 border-b border-border space-y-2">
        <textarea
          value={draftDescription}
          onChange={(e) => setDraftDescription(e.target.value)}
          placeholder="What would make the dashboard better? (Markdown links work too.)"
          rows={2}
          className="w-full px-3 py-2 text-sm border border-border-strong rounded-md bg-surface text-fg resize-y"
        />
        <div className="flex flex-wrap items-center gap-2">
          {/* Team toggle — drives the team badge on the row + which
              filter tab the request lands in. Buttons (not a select)
              so both options are visible at a glance. */}
          <div
            className="inline-flex rounded-md border border-border-strong overflow-hidden"
            role="group"
            aria-label="Submitter team"
          >
            {(["csm", "am"] as FeatureRequestTeam[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setDraftTeam(t)}
                className={`px-2 py-1 text-xs font-medium transition-colors ${
                  draftTeam === t
                    ? t === "csm"
                      ? "bg-indigo-600 text-white"
                      : "bg-purple-600 text-white"
                    : "bg-surface text-muted hover:bg-canvas"
                }`}
              >
                {TEAM_LABEL[t]}
              </button>
            ))}
          </div>
          <label className="text-xs text-muted flex items-center gap-1.5">
            Name
            <input
              type="text"
              value={draftSubmitter}
              onChange={(e) => setDraftSubmitter(e.target.value)}
              list="csm-presets"
              placeholder="Your name"
              className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface text-fg min-w-[140px]"
            />
            <datalist id="csm-presets">
              {CSM_PRESETS.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label className="text-xs text-muted flex items-center gap-1.5">
            Priority
            <select
              value={draftPriority}
              onChange={(e) =>
                setDraftPriority(e.target.value as FeatureRequestPriority)
              }
              className="px-2 py-1 text-xs border border-border-strong rounded-md bg-surface text-fg"
            >
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
          <div className="flex-1" />
          <button
            type="button"
            onClick={addFromComposer}
            disabled={
              !draftDescription.trim() || submitting || !viewerEmail
            }
            className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
          >
            {submitting ? "Submitting…" : "Submit"}
          </button>
        </div>
        {!viewerEmail ? (
          <p className="text-[11px] text-amber-600 dark:text-amber-300">
            Sign in to submit requests.
          </p>
        ) : null}
      </div>

      {/* Status messages */}
      {loadError ? (
        <div className="px-5 py-2 text-xs text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-500/10 border-b border-red-200 dark:border-red-500/30">
          Couldn&apos;t load requests: {loadError}
        </div>
      ) : null}
      {writeError ? (
        <div className="px-5 py-2 text-xs text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-500/10 border-b border-red-200 dark:border-red-500/30">
          Last save failed: {writeError}
        </div>
      ) : null}
      {commentFeedback ? (
        <div className="px-5 py-2 text-xs text-muted bg-blue-50 dark:bg-blue-500/10 border-b border-blue-200 dark:border-accent/30">
          {commentFeedback}
        </div>
      ) : null}

      {/* Team filter tabs. Counts read against the full list (not
          the current filter) so each tab advertises its own size.
          "all" is the default — the board still works as one shared
          backlog at a glance. */}
      <div className="px-5 py-2 bg-canvas/20 border-b border-border flex items-center gap-1">
        {(
          [
            { key: "all", label: "All", count: allSorted.length },
            { key: "csm", label: "CSM", count: csmTotal },
            { key: "am", label: "AM", count: amTotal },
          ] as Array<{
            key: FeatureRequestTeam | "all";
            label: string;
            count: number;
          }>
        ).map((tab) => {
          const active = teamFilter === tab.key;
          // Match the row-badge palette so the active tab visually
          // ties to the rows it surfaces.
          const activeBg =
            tab.key === "csm"
              ? "bg-indigo-600 text-white"
              : tab.key === "am"
                ? "bg-purple-600 text-white"
                : "bg-accent text-accent-fg";
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setTeamFilter(tab.key)}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                active
                  ? activeBg
                  : "text-muted hover:text-fg hover:bg-canvas"
              }`}
            >
              {tab.label}{" "}
              <span
                className={`ml-1 font-mono ${
                  active ? "opacity-80" : "text-subtle"
                }`}
              >
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* List */}
      {requests === null ? (
        <div className="px-5 py-6 text-sm text-muted">Loading…</div>
      ) : sortedRequests.length === 0 ? (
        <div className="px-5 py-6 text-sm text-muted">
          No requests yet. Be the first to submit one above.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {sortedRequests.map((req, idx) => {
            const isFirst = idx === 0;
            const isLast = idx === sortedRequests.length - 1;
            const voted = viewerEmail
              ? req.votes.includes(viewerEmail.toLowerCase())
              : false;
            const editState = editing[req.id];
            return (
              <li
                key={req.id}
                className="px-5 py-3 flex items-start gap-3 hover:bg-canvas/30 transition-colors"
              >
                {/* Reorder arrows */}
                <div className="flex flex-col items-center gap-0.5 text-subtle pt-1">
                  <button
                    type="button"
                    onClick={() => void moveRequest(req, "up")}
                    disabled={isFirst}
                    className="px-1 hover:text-fg disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Move up"
                    aria-label="Move up"
                  >
                    ▲
                  </button>
                  <span
                    className="text-[10px] font-mono"
                    title="Manual rank — drives the order. Edit via ↑ / ↓."
                  >
                    #{idx + 1}
                  </span>
                  <button
                    type="button"
                    onClick={() => void moveRequest(req, "down")}
                    disabled={isLast}
                    className="px-1 hover:text-fg disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Move down"
                    aria-label="Move down"
                  >
                    ▼
                  </button>
                </div>

                {/* Vote button + count */}
                <button
                  type="button"
                  onClick={() => void toggleVote(req)}
                  disabled={!viewerEmail}
                  className={`flex flex-col items-center justify-center min-w-[48px] px-2 py-1 rounded-md border text-[11px] font-medium transition-colors disabled:opacity-50 ${
                    voted
                      ? "bg-accent text-accent-fg border-accent"
                      : "bg-surface border-border-strong text-fg hover:bg-canvas"
                  }`}
                  title={voted ? "Remove your vote" : "Vote for this"}
                >
                  <span className="text-lg leading-none">▲</span>
                  <span className="font-mono">{req.votes.length}</span>
                </button>

                {/* Body */}
                <div className="flex-1 min-w-0">
                  {editState ? (
                    <div className="space-y-2">
                      <textarea
                        value={editState.description}
                        onChange={(e) =>
                          setEditing((prev) => ({
                            ...prev,
                            [req.id]: { description: e.target.value },
                          }))
                        }
                        rows={3}
                        className="w-full px-2 py-1.5 text-sm border border-border-strong rounded-md bg-surface text-fg resize-y"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            const description = editState.description.trim();
                            if (description && description !== req.description) {
                              void patchRequest(req.id, { description });
                            }
                            setEditing((prev) => {
                              const next = { ...prev };
                              delete next[req.id];
                              return next;
                            });
                          }}
                          className="px-2 py-1 text-xs bg-accent text-accent-fg rounded-md hover:bg-accent-hover"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setEditing((prev) => {
                              const next = { ...prev };
                              delete next[req.id];
                              return next;
                            })
                          }
                          className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-fg whitespace-pre-wrap break-words">
                      {req.description}
                    </p>
                  )}

                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
                    <TeamSelect
                      value={req.team ?? "csm"}
                      onChange={(v) => void patchRequest(req.id, { team: v })}
                    />
                    <span
                      className="text-muted"
                      title={`Submitted by ${req.submitter_email}`}
                    >
                      {req.submitter || "—"}
                    </span>
                    <span className="text-subtle">·</span>
                    <PrioritySelect
                      value={req.priority}
                      onChange={(v) =>
                        void patchRequest(req.id, { priority: v })
                      }
                    />
                    <StatusSelect
                      value={req.status}
                      onChange={(v) => void patchRequest(req.id, { status: v })}
                    />
                    <span className="text-subtle">·</span>
                    <button
                      type="button"
                      onClick={() =>
                        setEditing((prev) => ({
                          ...prev,
                          [req.id]: { description: req.description },
                        }))
                      }
                      className="text-accent hover:underline"
                    >
                      Edit
                    </button>
                    {deleteConfirmId === req.id ? (
                      <>
                        <span className="text-red-700 dark:text-red-300">
                          Delete?
                        </span>
                        <button
                          type="button"
                          onClick={() => void deleteRequest(req.id)}
                          className="text-red-600 dark:text-red-300 font-medium hover:underline"
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteConfirmId(null)}
                          className="text-muted hover:underline"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void deleteRequest(req.id)}
                        className="text-red-600 dark:text-red-300 hover:underline"
                      >
                        Delete
                      </button>
                    )}
                    <span className="text-subtle">·</span>
                    <button
                      type="button"
                      onClick={() =>
                        setCommentDrafts((prev) => ({
                          ...prev,
                          [req.id]: prev[req.id] ?? "",
                        }))
                      }
                      disabled={!viewerEmail}
                      className="text-accent hover:underline disabled:opacity-50"
                      title={
                        viewerEmail
                          ? "Leave a comment — pings the requester in Slack"
                          : "Sign in to comment"
                      }
                    >
                      Comment
                      {(req.comments ?? []).length > 0
                        ? ` (${req.comments!.length})`
                        : ""}
                    </button>
                  </div>

                  {(req.comments ?? []).length > 0 ? (
                    <ul className="mt-2 space-y-2">
                      {(req.comments ?? []).map((c) => (
                        <li
                          key={c.id}
                          className="pl-2 border-l-2 border-border text-xs"
                        >
                          <span className="font-medium text-fg">
                            {c.author_name}
                          </span>
                          <span className="text-subtle ml-1.5">
                            {fmtDate(c.created_at)}
                          </span>
                          <p className="text-muted whitespace-pre-wrap break-words mt-0.5 leading-relaxed">
                            {c.body}
                          </p>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {commentDrafts[req.id] !== undefined ? (
                    <div className="mt-2 space-y-1.5">
                      <textarea
                        value={commentDrafts[req.id]}
                        onChange={(e) =>
                          setCommentDrafts((prev) => ({
                            ...prev,
                            [req.id]: e.target.value,
                          }))
                        }
                        rows={2}
                        placeholder="Reply to the requester…"
                        className="w-full px-2 py-1.5 text-xs border border-border-strong rounded-md bg-surface text-fg resize-y"
                        autoFocus
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void postComment(req.id)}
                          disabled={
                            !commentDrafts[req.id]?.trim() ||
                            commentBusyId === req.id
                          }
                          className="px-2 py-1 text-xs bg-accent text-accent-fg rounded-md hover:bg-accent-hover disabled:opacity-50"
                        >
                          {commentBusyId === req.id
                            ? "Posting…"
                            : "Post & ping in Slack"}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setCommentDrafts((prev) => {
                              const next = { ...prev };
                              delete next[req.id];
                              return next;
                            })
                          }
                          disabled={commentBusyId === req.id}
                          className="px-2 py-1 text-xs border border-border-strong rounded-md hover:bg-canvas disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <span className="text-[10px] text-subtle">
                          Pings {req.submitter || "the requester"} in Slack
                          and adds a to-do when they&apos;re not you
                        </span>
                      </div>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Inline priority dropdown with subtle color cues so a high-priority
 *  row reads quickly in a long list. */
function PrioritySelect({
  value,
  onChange,
}: {
  value: FeatureRequestPriority;
  onChange: (v: FeatureRequestPriority) => void;
}) {
  const color =
    value === "high"
      ? "text-red-700 dark:text-red-300 border-red-200 dark:border-red-500/40"
      : value === "medium"
        ? "text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-500/40"
        : "text-muted border-border";
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as FeatureRequestPriority)}
      className={`px-1.5 py-0.5 text-[11px] rounded border bg-surface font-medium ${color}`}
      title="Priority"
    >
      <option value="high">High</option>
      <option value="medium">Medium</option>
      <option value="low">Low</option>
    </select>
  );
}

/** Inline status dropdown with status-mapped colors so a "shipped"
 *  row reads visibly different from "in progress". */
function StatusSelect({
  value,
  onChange,
}: {
  value: FeatureRequestStatus;
  onChange: (v: FeatureRequestStatus) => void;
}) {
  const color =
    value === "shipped"
      ? "text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/40"
      : value === "in_progress"
        ? "text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-500/40"
        : value === "declined"
          ? "text-subtle border-border line-through"
          : "text-muted border-border";
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as FeatureRequestStatus)}
      className={`px-1.5 py-0.5 text-[11px] rounded border bg-surface font-medium ${color}`}
      title="Status"
    >
      {(Object.keys(STATUS_LABEL) as FeatureRequestStatus[]).map((s) => (
        <option key={s} value={s}>
          {STATUS_LABEL[s]}
        </option>
      ))}
    </select>
  );
}

/** Inline team chip that doubles as a dropdown — single-click change
 *  with strong color coding so CSM rows and AM rows read visibly
 *  different in a long list. Palette matches the composer toggle +
 *  the filter tabs so the visual language stays consistent
 *  end-to-end. */
function TeamSelect({
  value,
  onChange,
}: {
  value: FeatureRequestTeam;
  onChange: (v: FeatureRequestTeam) => void;
}) {
  const color =
    value === "am"
      ? "bg-purple-100 dark:bg-purple-500/20 text-purple-800 dark:text-purple-200 border-purple-300 dark:border-purple-500/40"
      : "bg-indigo-100 dark:bg-indigo-500/20 text-indigo-800 dark:text-indigo-200 border-indigo-300 dark:border-indigo-500/40";
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as FeatureRequestTeam)}
      className={`px-1.5 py-0.5 text-[11px] rounded border font-semibold ${color}`}
      title="Team — which queue this request belongs to"
    >
      {(Object.keys(TEAM_LABEL) as FeatureRequestTeam[]).map((t) => (
        <option key={t} value={t}>
          {TEAM_LABEL[t]}
        </option>
      ))}
    </select>
  );
}

// Suppress unused-import warning on PRIORITY_LABEL — re-exported for
// consumers that want consistent labels but unused in this file.
void PRIORITY_LABEL;
