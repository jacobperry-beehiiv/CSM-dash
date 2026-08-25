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
  const cfg = sourceConfigs[todo.source as AutomatedSource];
  // Per-variant binding wins over the default. For renewal_milestone
  // today the variant key is String(source_meta.milestone_days) — a
  // 90-day todo picks up cfg.linked_template_by_variant["90"] when
  // set, falling back to cfg.linked_template_id when it isn't.
  const milestoneDays = todo.source_meta?.milestone_days;
  const variantKey = milestoneDays != null ? String(milestoneDays) : null;
  const variantBinding =
    variantKey != null ? cfg?.linked_template_by_variant?.[variantKey] : null;
  const linkedTemplateId = variantBinding ?? cfg?.linked_template_id ?? null;
  if (!workspaceId || !linkedTemplateId) return null;

  async function openModal() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/customers/by-workspace?workspace_id=${encodeURIComponent(
          workspaceId as string
        )}`
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
