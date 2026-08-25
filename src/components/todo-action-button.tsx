"use client";

import { useState } from "react";
import type { Customer } from "@/lib/types";
import type { PersonalTodo } from "@/lib/personal-todos/types";
import type { AutomatedSource, TodoSourceConfig } from "@/lib/data/todo-source-configs-types";
import { OutreachModal } from "./outreach-modal";

/**
 * "Draft outreach" button rendered next to a todo when the todo's
 * source has a linked outreach template in the /settings/todo-
 * automation registry AND the todo carries a workspace_id in
 * source_meta.
 *
 * On click: fetch the customer by workspace_id, then open the
 * standard OutreachModal with the linked template pre-selected via
 * its `initialScenario` prop.
 *
 * The button silently hides itself when either half of the wiring is
 * missing (no workspace_id, or no linked template for this source) —
 * every automated todo either has a linked action or doesn't.
 */

interface Props {
  todo: PersonalTodo;
  /** Effective config map — usually loaded once by the parent panel
   *  and passed down. Sparse: only sources with a linked template
   *  need to appear here. */
  sourceConfigs: Partial<Record<AutomatedSource, TodoSourceConfig>>;
}

export function TodoActionButton({ todo, sourceConfigs }: Props) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workspaceId = todo.source_meta?.workspace_id;
  // slack_assign todos don't carry workspace_id — the @bot assign
  // spawn point only knows hubspot_company_id. The by-workspace
  // endpoint accepts either param, so we fall back to it when
  // workspace_id is missing.
  const hubspotCompanyId = todo.source_meta?.hubspot_company_id;
  const canResolveCustomer = Boolean(workspaceId || hubspotCompanyId);
  const cfg = sourceConfigs[todo.source as AutomatedSource];
  // Per-variant binding wins over the default. The variant key is
  // stamped by the engine on source_meta with a source-specific
  // field, so we pick it per source rather than picking one common
  // field:
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
  const variantBinding =
    variantKey != null ? cfg?.linked_template_by_variant?.[variantKey] : null;
  const linkedTemplateId = variantBinding ?? cfg?.linked_template_id ?? null;
  if (!canResolveCustomer || !linkedTemplateId) return null;

  async function openModal() {
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
      const body = (await r.json()) as {
        customer?: Customer;
        error?: string;
      };
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
        onClick={openModal}
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
          initialScenario={linkedTemplateId}
        />
      ) : null}
    </>
  );
}
