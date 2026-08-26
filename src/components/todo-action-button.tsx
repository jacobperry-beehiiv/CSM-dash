"use client";

import { useState } from "react";
import type { Customer } from "@/lib/types";
import type { PersonalTodo } from "@/lib/personal-todos/types";
import {
  resolveTodoAction,
  type AutomatedSource,
  type TodoAction,
  type TodoSourceConfig,
} from "@/lib/data/todo-source-configs-types";
import { OutreachModal } from "./outreach-modal";

/**
 * Action button rendered next to a todo when the todo's source has a
 * bound action (email or Slack) in the /settings/todo-automation
 * registry AND the todo carries enough context to resolve a customer
 * (workspace_id or hubspot_company_id in source_meta).
 *
 * Two shapes based on action kind:
 *   - email → "✉︎ Draft outreach" → opens OutreachModal with the
 *             template pre-selected via `initialScenario`.
 *   - slack → "📣 Send Slack" → posts the configured message to the
 *             configured channel via /api/todo-actions/slack. Small
 *             inline confirm so a fat-fingered click doesn't spray a
 *             channel.
 *
 * Silently hides when the wiring is missing (no action, no resolvable
 * customer). Not our job to render "misconfigured" here — the settings
 * page is where admins see that state.
 */

interface Props {
  todo: PersonalTodo;
  /** Effective config map — usually loaded once by the parent panel
   *  and passed down. Sparse: only sources with an override entry need
   *  to appear here; downstream code merges against shipped defaults. */
  sourceConfigs: Partial<Record<AutomatedSource, TodoSourceConfig>>;
}

export function TodoActionButton({ todo, sourceConfigs }: Props) {
  const workspaceId = todo.source_meta?.workspace_id;
  // slack_assign todos don't carry workspace_id — the @bot assign
  // spawn point only knows hubspot_company_id. The by-workspace
  // endpoint accepts either param, so we fall back to it when
  // workspace_id is missing.
  const hubspotCompanyId = todo.source_meta?.hubspot_company_id;
  const canResolveCustomer = Boolean(workspaceId || hubspotCompanyId);
  const cfg = sourceConfigs[todo.source as AutomatedSource];

  // Variant key per source — the engine stamps it on source_meta with
  // a source-specific field:
  //   - renewal_milestone → String(source_meta.milestone_days)
  //     ("90", "60", "30", "7")
  //   - slack_assign      → source_meta.playbook_step
  //     ("onboarding:confirm_handoff", "live:intro_call", …)
  // Other sources don't have variants today.
  const variantKey = ((): string | null => {
    if (todo.source === "renewal_milestone") {
      const d = todo.source_meta?.milestone_days;
      return d != null ? String(d) : null;
    }
    if (todo.source === "slack_assign") {
      return todo.source_meta?.playbook_step ?? null;
    }
    return null;
  })();

  const action: TodoAction = cfg
    ? resolveTodoAction(cfg, variantKey)
    : { kind: "none" };
  if (!canResolveCustomer || action.kind === "none") return null;

  if (action.kind === "email") {
    return (
      <EmailActionButton
        workspaceId={workspaceId ?? null}
        hubspotCompanyId={hubspotCompanyId ?? null}
        templateId={action.template_id}
      />
    );
  }
  return (
    <SlackActionButton
      todoId={todo.id}
      workspaceId={workspaceId ?? null}
      hubspotCompanyId={hubspotCompanyId ?? null}
      source={todo.source}
      variantKey={variantKey}
      channelId={action.channel_id}
    />
  );
}

// ─── Email action ─────────────────────────────────────────────────────────

function EmailActionButton({
  workspaceId,
  hubspotCompanyId,
  templateId,
}: {
  workspaceId: string | null;
  hubspotCompanyId: string | null;
  templateId: string;
}) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (workspaceId) params.set("workspace_id", workspaceId);
      else if (hubspotCompanyId)
        params.set("hubspot_company_id", String(hubspotCompanyId));
      const r = await fetch(
        `/api/customers/by-workspace?${params.toString()}`
      );
      const body = (await r.json()) as { customer?: Customer; error?: string };
      if (!r.ok || !body.customer) {
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      setCustomer(body.customer);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={open}
        disabled={loading}
        className="text-[11px] px-2 py-0.5 rounded border border-indigo-300 dark:border-indigo-500/40 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-900 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-500/20 disabled:opacity-50"
        title="Open the outreach modal for this customer with the linked template pre-selected"
      >
        {loading ? "Loading…" : "✉︎ Draft outreach"}
      </button>
      {error ? (
        <span className="text-[11px] text-red-700 dark:text-red-300">
          {error}
        </span>
      ) : null}
      {customer ? (
        <OutreachModal
          customer={customer}
          onClose={() => setCustomer(null)}
          initialScenario={templateId}
        />
      ) : null}
    </>
  );
}

// ─── Slack action ─────────────────────────────────────────────────────────

function SlackActionButton({
  todoId,
  workspaceId,
  hubspotCompanyId,
  source,
  variantKey,
  channelId,
}: {
  todoId: string;
  workspaceId: string | null;
  hubspotCompanyId: string | null;
  source: string;
  variantKey: string | null;
  channelId: string;
}) {
  const [state, setState] = useState<
    "idle" | "confirming" | "sending" | "sent" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setState("sending");
    setError(null);
    try {
      const r = await fetch("/api/todo-actions/slack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          todo_id: todoId,
          workspace_id: workspaceId,
          hubspot_company_id: hubspotCompanyId,
          source,
          variant_key: variantKey,
        }),
      });
      const body = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !body.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setState("sent");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
      setState("error");
    }
  }

  if (state === "sent") {
    return (
      <span className="text-[11px] text-emerald-700 dark:text-emerald-300">
        ✓ Posted to #{channelId.slice(0, 5)}…
      </span>
    );
  }

  if (state === "confirming" || state === "sending") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px]">
        <span className="text-subtle">Post to Slack channel {channelId}?</span>
        <button
          type="button"
          onClick={send}
          disabled={state === "sending"}
          className="px-1.5 py-0.5 rounded border border-emerald-400 dark:border-emerald-500/50 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-900 dark:text-emerald-200 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 disabled:opacity-50"
        >
          {state === "sending" ? "Sending…" : "Yes, send"}
        </button>
        <button
          type="button"
          onClick={() => setState("idle")}
          disabled={state === "sending"}
          className="px-1.5 py-0.5 rounded border border-border text-subtle hover:bg-canvas/60"
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setState("confirming")}
        className="text-[11px] px-2 py-0.5 rounded border border-purple-300 dark:border-purple-500/40 bg-purple-50 dark:bg-purple-500/10 text-purple-900 dark:text-purple-200 hover:bg-purple-100 dark:hover:bg-purple-500/20"
        title={`Post the configured message to Slack channel ${channelId}`}
      >
        📣 Send Slack
      </button>
      {error ? (
        <span className="text-[11px] text-red-700 dark:text-red-300">
          {error}
        </span>
      ) : null}
    </>
  );
}
