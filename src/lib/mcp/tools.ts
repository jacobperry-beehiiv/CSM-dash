import { loadCustomers, isEnterprise } from "../data/load-customers";
import { listSignals, upsertSignalsForWorkspace, VALID_SIGNAL_KINDS, type AppendInput, type SignalKind } from "../data/customer-signals";
import { setRunState } from "../data/customer-signals-state";
import { loadPastDue } from "../engines/am-cohorts";
import { runAtRiskCheck } from "../engines/at-risk";
import { getTeamTasks, saveTeamTasks } from "../team-tasks/store";
import { newMemberId, type TeamTask, type TaskPriority } from "../team-tasks/types";
import { setOverride } from "../data/customer-overrides";
import { invalidateCustomerCache } from "../data/load-customers";
import { applyTodoOps } from "../personal-todos/store";
import { userKeyFromEmail } from "../personal-todos/identity";
import {
  newTodoId,
  type PersonalTodo,
  type TodoPriority,
} from "../personal-todos/types";
import { CHECKLIST_GROUP_OPTIONS } from "../lifecycle/checklist-groups";
import { LIVE_ONGOING_GROUP } from "../lifecycle/live-quarter";
import type { Customer, RiskFlagCode } from "../types";

/**
 * Tool registry for the MCP server at /api/mcp.
 *
 * Each tool is a thin wrapper around an existing data/store path —
 * the MCP server is a typed-tool surface over the same operations
 * the dashboard already exposes via REST. Per-user attribution comes
 * from the Bearer-token owner (ctx.user_email), passed in by the
 * route handler after auth succeeds.
 */

export interface ToolContext {
  /** Email of the CSM whose API token authenticated the request.
   *  Drives `created_by` on signals + future audit fields. */
  user_email: string;
}

export interface ToolResult {
  /** MCP content blocks. We always return a single text block whose
   *  body is JSON-stringified for structured data — Claude is happy
   *  to parse JSON out of text and it keeps the wire format simple. */
  content: Array<{ type: "text"; text: string }>;
  /** Optional flag exposed to Claude — if true the model surfaces the
   *  text content as an error rather than a success. */
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema (Draft-07-ish) for the arguments object. MCP clients
   *  use this to build the tool's input UI. */
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

// ─── Small helpers ────────────────────────────────────────────────

function ok(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function fail(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Lean per-customer projection — full Customer is ~30 fields and most
 *  callers only need the headline ones. */
function summarizeCustomer(c: Customer): Record<string, unknown> {
  return {
    workspace_id: c.workspace_id,
    workspace_name: c.workspace_name,
    company_name: c.company_name,
    owner_email: c.owner_email,
    csm: c.customer_success_manager,
    plan: c.stripe_plan,
    arr: c.arr,
    mrr: c.mrr,
    active_subs: c.active_subs,
    max_subscriptions: c.max_subscriptions,
    risk_level: c.property_risk_level,
    company_status: c.property_company_status,
    engagement: c.company_engagement,
    renewal_date: c.renewal_date,
    is_enterprise: isEnterprise(c),
  };
}

// ─── Tools ────────────────────────────────────────────────────────

const customerSearch: Tool = {
  name: "customer.search",
  description:
    "Search the customer book by free-text query (matches company_name, " +
    "workspace_name, owner_email, stripe_customer_id, or workspace_id). " +
    "Returns a lean list — use customer.get for full detail on one workspace.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Free-text search query. Case-insensitive substring match.",
      },
      limit: {
        type: "number",
        description: "Max results to return. Default 25.",
      },
    },
    required: ["query"],
  },
  async handler(args) {
    const query = asString(args.query);
    if (!query) return fail("`query` is required");
    const limit = asNumber(args.limit) ?? 25;
    const all = await loadCustomers();
    const q = query.toLowerCase();
    const hits = all
      .filter((c) => {
        const haystack = [
          c.workspace_id,
          c.workspace_name,
          c.company_name,
          c.owner_email,
          c.stripe_customer_id,
          c.customer_success_manager,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      })
      .slice(0, limit)
      .map(summarizeCustomer);
    return ok({ query, count: hits.length, results: hits });
  },
};

const customerGet: Tool = {
  name: "customer.get",
  description:
    "Fetch one customer's full profile + latest signals + HubSpot contacts. " +
    "`id` accepts workspace_id, stripe_customer_id, or workspace_name " +
    "(same resolution as /account/<id>).",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description:
          "Workspace UUID, Stripe cus_… id, or workspace_name. " +
          "Try customer.search first if you don't know the exact value.",
      },
    },
    required: ["id"],
  },
  async handler(args) {
    const id = asString(args.id);
    if (!id) return fail("`id` is required");
    const all = await loadCustomers();
    const c = all.find(
      (x) =>
        x.workspace_id === id ||
        x.stripe_customer_id === id ||
        x.workspace_name === id
    );
    if (!c) {
      return fail(
        `No customer matches "${id}" by workspace_id, stripe_customer_id, or workspace_name. ` +
          `Try customer.search to find the right id.`
      );
    }
    const signals = c.workspace_id ? await listSignals(c.workspace_id) : [];
    return ok({
      customer: c,
      signals,
      signal_count: signals.length,
    });
  },
};

const signalsList: Tool = {
  name: "signals.list",
  description:
    "Read the current signals stream for one workspace (notes, " +
    "touchpoints, risk signals, action items, etc.).",
  inputSchema: {
    type: "object",
    properties: {
      workspace_id: {
        type: "string",
        description: "Workspace UUID. Find via customer.search.",
      },
    },
    required: ["workspace_id"],
  },
  async handler(args) {
    const workspaceId = asString(args.workspace_id);
    if (!workspaceId) return fail("`workspace_id` is required");
    const signals = await listSignals(workspaceId);
    return ok({ workspace_id: workspaceId, count: signals.length, signals });
  },
};

const atRiskList: Tool = {
  name: "at_risk.list",
  description:
    "List flagged at-risk Enterprise accounts. Optional filters: " +
    "`csm` narrows to one CSM's book; `flags` filters to accounts " +
    "carrying any of the given flag codes:\n" +
    "  A = No publishing 10d+ (no recent send)\n" +
    "  B = No login 14d+ (no admin login to beehiiv)\n" +
    "  C = Under cap (<75% of subscriber limit)\n" +
    "  D = Frustration signal (Gmail negative sentiment)\n" +
    "  E = No outbound 90d+ (no Gmail to company)\n" +
    "  F = News mention\n" +
    "  G = CSM-flagged risk (Yellow/Red on HubSpot)\n" +
    "  H = Stale HubSpot activity 45d+",
  inputSchema: {
    type: "object",
    properties: {
      csm: {
        type: "string",
        description: "Internal CSM handle, e.g. 'Jacob_Perry'.",
      },
      flags: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional flag codes to filter on (A/B/C/G/H/...). Returns accounts carrying ANY of these.",
      },
      limit: { type: "number", description: "Max results. Default 100." },
    },
  },
  async handler(args) {
    const csm = asString(args.csm);
    const flagsArg = Array.isArray(args.flags) ? args.flags : null;
    const limit = asNumber(args.limit) ?? 100;
    const all = await loadCustomers();
    const book = csm
      ? all.filter((c) => c.customer_success_manager === csm)
      : all;
    const result = await runAtRiskCheck({ customers: book, csmName: csm });
    let accounts = result.accounts;
    if (flagsArg && flagsArg.length > 0) {
      const wanted = new Set(flagsArg.map(String));
      accounts = accounts.filter((a) =>
        a.flags.some((f) => wanted.has(f.code))
      );
    }
    accounts = accounts.slice(0, limit);
    return ok({
      csm: csm ?? null,
      flags_filter: flagsArg ?? null,
      total_in_book: result.total_in_book,
      excluded: result.excluded,
      generated_at: result.generated_at,
      count: accounts.length,
      accounts: accounts.map((a) => ({
        customer: summarizeCustomer(a.customer),
        flag_codes: a.flags.map((f) => f.code),
        flags: a.flags,
        recommended_action: a.recommended_action,
      })),
    });
  },
};

const pastDueList: Tool = {
  name: "past_due.list",
  description:
    "List past-due subscriptions from Metabase q24620, with optional " +
    "filters for CSM ownership and plan tier (enterprise / non-enterprise).",
  inputSchema: {
    type: "object",
    properties: {
      csm: { type: "string", description: "Internal CSM handle." },
      plan_tier: {
        type: "string",
        enum: ["all", "enterprise", "non-enterprise"],
        description: "Plan tier filter. Default 'all'.",
      },
      limit: { type: "number", description: "Max results. Default 200." },
    },
  },
  async handler(args) {
    const csm = asString(args.csm);
    const planTier = asString(args.plan_tier) ?? "all";
    const limit = asNumber(args.limit) ?? 200;
    const all = await loadPastDue();
    let rows = all;
    if (csm) {
      rows = rows.filter((r) => r.customer_success_manager === csm);
    }
    if (planTier !== "all") {
      const isEnt = (priceName: string | null) =>
        /enterprise|custom/i.test(priceName ?? "");
      rows = rows.filter((r) =>
        planTier === "enterprise" ? isEnt(r.price_name) : !isEnt(r.price_name)
      );
    }
    rows = rows.slice(0, limit);
    return ok({
      csm: csm ?? null,
      plan_tier: planTier,
      total_returned: rows.length,
      total_arr: rows.reduce((s, r) => s + r.arr_dollars, 0),
      rows,
    });
  },
};

const teamTasksList: Tool = {
  name: "team_tasks.list",
  description:
    "Read the shared team-tasks tracker (the 'open asks' panel on the " +
    "mission-control root page). Returns tasks + the current team roster.",
  inputSchema: { type: "object", properties: {} },
  async handler() {
    const list = await getTeamTasks();
    return ok({
      task_count: list.tasks.length,
      member_count: list.members.length,
      members: list.members,
      tasks: list.tasks,
    });
  },
};

const signalsPost: Tool = {
  name: "signals.post",
  description:
    "Append or upsert a batch of customer signals. Mirrors the " +
    "POST /api/customer-signals batch shape — each signal carries " +
    "`signal_id`, `workspace_id`, `kind`, `event_at`, `text`, and " +
    "optional `metadata`. Caller-supplied `signal_id` triggers an " +
    "idempotent upsert; omit for append-with-random-id. " +
    "`created_by` defaults to your token's owning email.",
  inputSchema: {
    type: "object",
    properties: {
      signals: {
        type: "array",
        description:
          "One or more signals to upsert. See VALID_SIGNAL_KINDS for the kind taxonomy.",
        items: {
          type: "object",
          properties: {
            signal_id: {
              type: "string",
              description:
                "Deterministic id for upsert. e.g. 'tp_<workspace>_<thread>'. Omit to append a fresh row.",
            },
            workspace_id: { type: "string" },
            kind: {
              type: "string",
              enum: [...VALID_SIGNAL_KINDS],
            },
            text: { type: "string", description: "Human-readable summary." },
            event_at: {
              type: "string",
              description: "ISO 8601 timestamp of when the event happened.",
            },
            source: {
              type: "string",
              description: "Defaults to 'claude-mcp' when omitted.",
            },
            expires_at: {
              type: "string",
              description: "ISO 8601 or null. Past dates are filtered out on read.",
            },
            metadata: {
              type: "object",
              description: "Per-kind structured metadata. See skill spec.",
            },
          },
          required: ["workspace_id", "kind", "text"],
        },
      },
      run_id: {
        type: "string",
        description:
          "Optional run id for state tracking. Defaults to 'mcp-<timestamp>'.",
      },
    },
    required: ["signals"],
  },
  async handler(args, ctx) {
    const sigs = Array.isArray(args.signals) ? args.signals : null;
    if (!sigs || sigs.length === 0) {
      return fail("`signals` must be a non-empty array");
    }

    interface SignalLike {
      signal_id?: string;
      workspace_id?: string;
      kind?: string;
      text?: string;
      event_at?: string;
      source?: string;
      created_at?: string;
      expires_at?: string;
      metadata?: Record<string, unknown>;
    }

    // Group by workspace so each customer's row is one KV write.
    const byWorkspace = new Map<string, AppendInput[]>();
    const results: Array<{ signal_id?: string; status: string; error?: string; action?: string }> = [];
    for (const s of sigs as SignalLike[]) {
      const workspace = asString(s.workspace_id);
      const kind = asString(s.kind);
      const text = asString(s.text);
      if (!workspace) {
        results.push({ signal_id: s.signal_id, status: "rejected", error: "workspace_id required" });
        continue;
      }
      if (!kind || !(VALID_SIGNAL_KINDS as readonly string[]).includes(kind)) {
        results.push({
          signal_id: s.signal_id,
          status: "rejected",
          error: `kind must be one of: ${VALID_SIGNAL_KINDS.join(", ")}`,
        });
        continue;
      }
      if (!text) {
        results.push({ signal_id: s.signal_id, status: "rejected", error: "text required" });
        continue;
      }
      const input: AppendInput = {
        signal_id: s.signal_id,
        workspace_id: workspace,
        kind: kind as SignalKind,
        text: text.trim(),
        source: s.source ?? "claude-mcp",
        created_by: ctx.user_email,
        created_at: s.created_at,
        event_at: s.event_at,
        expires_at: s.expires_at,
        metadata: s.metadata,
      };
      const arr = byWorkspace.get(workspace) ?? [];
      arr.push(input);
      byWorkspace.set(workspace, arr);
    }

    for (const [workspace, inputs] of byWorkspace) {
      const groupResults = await upsertSignalsForWorkspace(workspace, inputs);
      groupResults.forEach((r, i) => {
        results.push({
          signal_id: inputs[i].signal_id ?? r.signal.id,
          status: "accepted",
          action: r.action,
        });
      });
    }

    // Record run state under the user's email so /state stays in sync
    // with what their MCP session just did.
    const runId =
      asString(args.run_id) ?? `mcp-${Date.now().toString(36)}`;
    const completedAt = new Date().toISOString();
    try {
      await setRunState({
        csm_email: ctx.user_email,
        last_successful_run: completedAt,
        last_run_id: runId,
      });
    } catch (e) {
      console.error("[mcp] setRunState failed:", e);
    }

    const accepted = results.filter((r) => r.status === "accepted").length;
    const rejected = results.length - accepted;
    return ok({
      run_id: runId,
      accepted,
      rejected,
      results,
      state: { csm_email: ctx.user_email, last_successful_run: completedAt },
    });
  },
};

const teamTasksAdd: Tool = {
  name: "team_tasks.add",
  description:
    "Add a new ask to the shared team-tasks tracker. Visible to every " +
    "CSM on the mission-control root page.",
  inputSchema: {
    type: "object",
    properties: {
      ask: {
        type: "string",
        description: "Short description of the ask. Required.",
      },
      due_date: {
        type: "string",
        description: "YYYY-MM-DD. Optional.",
      },
      loe: {
        type: "string",
        description:
          "Level-of-effort estimate, free-text (e.g. '10 mins', 'half a day'). Optional.",
      },
      priority: {
        type: "string",
        enum: ["high", "medium", "low"],
      },
      details: {
        type: "string",
        description:
          "Free-text notes / links. URLs are auto-linked when rendered.",
      },
    },
    required: ["ask"],
  },
  async handler(args, ctx) {
    const ask = asString(args.ask);
    if (!ask) return fail("`ask` is required");
    const list = await getTeamTasks();
    const now = new Date().toISOString();
    const task: TeamTask = {
      id:
        Math.random().toString(36).slice(2, 10) +
        Date.now().toString(36),
      ask: ask.trim(),
      due_date: asString(args.due_date),
      loe: asString(args.loe),
      priority: (asString(args.priority) as TaskPriority | null) ?? null,
      details:
        asString(args.details) ??
        `Added by ${ctx.user_email} via Claude MCP`,
      assignments: {},
      created_at: now,
      updated_at: now,
    };
    await saveTeamTasks({ ...list, tasks: [...list.tasks, task] });
    return ok({ task });
  },
};

// ─── personal_todos.add ───────────────────────────────────────────

const CHECKLIST_GROUP_VALUES = CHECKLIST_GROUP_OPTIONS.map((g) => g.value);
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const TODO_PRIORITIES: TodoPriority[] = ["high", "medium", "low"];

/** Resolves a free-text company reference to exactly one customer, or
 *  an error listing the candidates so Claude can ask the CSM which
 *  one they meant. Tries the unambiguous identifiers first (workspace
 *  id, Stripe id), then exact name, then substring — and collapses
 *  matches that share a hubspot_company_id, since several workspaces
 *  under one company are the same thing for to-do purposes. */
function resolveCompany(
  query: string,
  all: Customer[]
): { customer: Customer } | { error: string } {
  const q = query.trim().toLowerCase();
  const byId = all.find(
    (c) =>
      c.workspace_id === query.trim() || c.stripe_customer_id === query.trim()
  );
  if (byId) return { customer: byId };

  const names = (c: Customer) =>
    [c.company_name, c.workspace_name].filter(Boolean).map((n) => n!.toLowerCase());
  const exact = all.filter((c) => names(c).includes(q));
  const pool = exact.length > 0 ? exact : all.filter((c) => names(c).some((n) => n.includes(q)));

  const unique = new Map<string, Customer>();
  for (const c of pool) {
    const key = c.hubspot_company_id ?? c.workspace_id ?? c.workspace_name ?? "";
    if (!unique.has(key)) unique.set(key, c);
  }
  if (unique.size === 1) return { customer: [...unique.values()][0] };
  if (unique.size === 0) {
    return {
      error: `No company matches "${query}". Try customer.search to find the right name or workspace_id.`,
    };
  }
  const shown = [...unique.values()].slice(0, 8).map(
    (c) =>
      `${c.company_name ?? c.workspace_name} (workspace_id ${c.workspace_id}, CSM ${c.customer_success_manager ?? "unassigned"})`
  );
  return {
    error:
      `"${query}" matches ${unique.size} companies — ask which one, then retry with its workspace_id: ` +
      shown.join("; ") +
      (unique.size > shown.length ? "; …" : ""),
  };
}

const personalTodosAdd: Tool = {
  name: "personal_todos.add",
  description:
    "Create a to-do on YOUR OWN to-do list in the dashboard (the 'Your " +
    "to-dos' panel), optionally linked to a company so it also appears " +
    "on that company's Lifecycle board card. Always lands on the list of " +
    "whoever owns the API token — never someone else's. Distinct from " +
    "team_tasks.add (a shared team-wide tracker) and signals.post (a " +
    "read-only notes feed on the customer profile). When `company` is " +
    "set the title is auto-prefixed with the company name, matching the " +
    "dashboard's own composer.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "What needs doing. Required.",
      },
      company: {
        type: "string",
        description:
          "Company to link this to — workspace_id, Stripe cus_… id, or " +
          "company/workspace name. Optional; omit for a plain to-do with no " +
          "company. If a name is ambiguous the call fails with the " +
          "candidates; retry with a workspace_id.",
      },
      checklist_group: {
        type: "string",
        enum: CHECKLIST_GROUP_VALUES,
        description:
          "Which Lifecycle-board checklist group the to-do sits under. " +
          "Only valid with `company`. Defaults to 'Live' (shown as " +
          "'To-do' in the dashboard) — correct for accounts already live. " +
          "For an account still being onboarded use 'Pre-kickoff', " +
          "'Post-kickoff', or 'Migration & warm-up' (shown as " +
          "'Migrating'), otherwise it won't show on that account's " +
          "Onboarding card.",
      },
      due_date: {
        type: "string",
        description: "YYYY-MM-DD. Optional. Drives Slack due-date reminders.",
      },
      surface_at: {
        type: "string",
        description:
          "YYYY-MM-DD. Optional. If in the future the to-do stays hidden " +
          "(under 'Scheduled') until that date.",
      },
      priority: {
        type: "string",
        enum: TODO_PRIORITIES,
      },
      details: {
        type: "string",
        description: "Free-text notes / links. Optional.",
      },
    },
    required: ["title"],
  },
  async handler(args, ctx) {
    const rawTitle = asString(args.title)?.trim();
    if (!rawTitle) return fail("`title` is required");

    const dueDate = asString(args.due_date);
    const surfaceAt = asString(args.surface_at);
    for (const [field, value] of [
      ["due_date", dueDate],
      ["surface_at", surfaceAt],
    ] as const) {
      if (value && !YMD.test(value)) {
        return fail(`\`${field}\` must be YYYY-MM-DD, got "${value}"`);
      }
    }
    const priority = asString(args.priority);
    if (priority && !TODO_PRIORITIES.includes(priority as TodoPriority)) {
      return fail(`\`priority\` must be one of: ${TODO_PRIORITIES.join(", ")}`);
    }

    const companyQuery = asString(args.company);
    const groupArg = asString(args.checklist_group);
    if (groupArg && !companyQuery) {
      return fail(
        "`checklist_group` only applies to a to-do linked to a company — pass `company` too, or drop `checklist_group`."
      );
    }
    if (groupArg && !CHECKLIST_GROUP_VALUES.includes(groupArg)) {
      return fail(
        `\`checklist_group\` must be one of: ${CHECKLIST_GROUP_VALUES.join(", ")}`
      );
    }

    let title = rawTitle;
    let linked: Customer | null = null;
    let group: string | null = null;
    let warning: string | null = null;
    if (companyQuery) {
      const resolved = resolveCompany(companyQuery, await loadCustomers());
      if ("error" in resolved) return fail(resolved.error);
      linked = resolved.customer;
      const name = linked.company_name ?? linked.workspace_name ?? "this company";
      if (!linked.hubspot_company_id) {
        return fail(
          `${name} has no HubSpot company id on record, which is what links a to-do to a Lifecycle card. ` +
            `Omit \`company\` to create a plain to-do instead.`
        );
      }
      group = groupArg ?? LIVE_ONGOING_GROUP;
      if (!title.toLowerCase().includes(name.toLowerCase())) {
        title = `${name} — ${title}`;
      }
      const ownerEmail = linked.customer_success_manager_email?.trim().toLowerCase();
      if (ownerEmail !== ctx.user_email.trim().toLowerCase()) {
        warning =
          `${name} isn't in your book (CSM: ${linked.customer_success_manager ?? "unassigned"}), ` +
          `so this to-do is on your list but won't appear on a Lifecycle board card for you.`;
      }
    }

    const now = new Date().toISOString();
    const todo: PersonalTodo = {
      id: newTodoId(),
      title,
      details: asString(args.details)?.trim() || null,
      due_date: dueDate,
      surface_at: surfaceAt,
      priority: (priority as TodoPriority | null) ?? null,
      // Same source/source_meta shape the dashboard's own composer and
      // the on-card "+" write — "slack_assign" is what
      // matchPlaybookTodos keys on to put this on the company's card.
      source: linked ? "slack_assign" : surfaceAt ? "scheduled" : "manual",
      source_meta: linked
        ? { hubspot_company_id: linked.hubspot_company_id!, checklist_group: group! }
        : null,
      completed_at: null,
      created_at: now,
      updated_at: now,
    };
    await applyTodoOps(userKeyFromEmail(ctx.user_email), [{ type: "add", todo }]);
    return ok({
      todo,
      linked_company: linked
        ? {
            workspace_id: linked.workspace_id,
            company_name: linked.company_name ?? linked.workspace_name,
            checklist_group: group,
          }
        : null,
      ...(warning ? { warning } : {}),
    });
  },
};

const customerSetCadence: Tool = {
  name: "customer.set_cadence",
  description:
    "Override a customer's billing cadence (monthly vs annual). Use " +
    "this for one-off corrections when Stripe's interval doesn't " +
    "match the contract on file. Pass `interval: null` to clear an " +
    "existing override.",
  inputSchema: {
    type: "object",
    properties: {
      workspace_id: { type: "string" },
      interval: {
        type: ["string", "null"],
        enum: ["month", "annual", null],
        description:
          "'month' or 'annual'; null to clear an existing override.",
      },
    },
    required: ["workspace_id", "interval"],
  },
  async handler(args) {
    const workspaceId = asString(args.workspace_id);
    if (!workspaceId) return fail("`workspace_id` is required");
    const intervalRaw = args.interval;
    let interval: "month" | "annual" | undefined;
    if (intervalRaw === null) {
      interval = undefined;
    } else if (intervalRaw === "month" || intervalRaw === "annual") {
      interval = intervalRaw;
    } else {
      return fail("`interval` must be 'month', 'annual', or null");
    }
    const map = await setOverride(workspaceId, { interval });
    invalidateCustomerCache();
    return ok({ workspace_id: workspaceId, override: map[workspaceId] ?? null });
  },
};

// Reuse newMemberId so future tools that touch the roster don't fight
// the same logic. Silences an unused-import warning if every tool
// happens to skip it.
void newMemberId;

// ─── Registry ─────────────────────────────────────────────────────

export const TOOLS: Tool[] = [
  customerSearch,
  customerGet,
  signalsList,
  atRiskList,
  pastDueList,
  teamTasksList,
  signalsPost,
  teamTasksAdd,
  personalTodosAdd,
  customerSetCadence,
];

// Lookup is hot per request; keep a Map alongside the array.
export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// Silence unused-symbol warnings on types used in JSDoc/comments.
export type { RiskFlagCode };
