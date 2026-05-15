import { fmtDate } from "./format";
import type { CustomerSignal, SignalKind } from "@/lib/data/customer-signals";

/**
 * "Context & signals" panel on the account profile page. Renders the
 * stream of signals the Claude skill (or a CSM) posts via
 * /api/customer-signals, grouped by kind so each type shows with its
 * own structured metadata.
 *
 * Server-rendered — the page passes pre-fetched signals so there's no
 * loading state and no client-side hydration cost. Empty when nothing
 * has been posted yet; CSMs see a nudge pointing at the skill.
 */

interface MetadataMap {
  [k: string]: unknown;
}

// ─── Grouping ────────────────────────────────────────────────────

/** Display order for the kinds + the section title each renders under. */
const KIND_SECTIONS: Array<{
  id: string;
  title: string;
  kinds: SignalKind[];
}> = [
  { id: "overview", title: "Customer overview", kinds: ["customer_overview"] },
  {
    id: "open",
    title: "Open work",
    kinds: ["risk_signal", "action_item"],
  },
  {
    id: "context",
    title: "Strategic context",
    kinds: ["goal", "use_case", "feature_request", "feature_adoption"],
  },
  {
    id: "contacts",
    title: "Contact updates",
    kinds: ["contact_update"],
  },
  {
    id: "activity",
    title: "Activity",
    kinds: ["touchpoint", "meeting", "note", "win", "context"],
  },
];

function groupSignals(signals: CustomerSignal[]) {
  const byKind = new Map<SignalKind, CustomerSignal[]>();
  for (const s of signals) {
    const arr = byKind.get(s.kind) ?? [];
    arr.push(s);
    byKind.set(s.kind, arr);
  }
  // Sort each kind's list newest-first by event_at/created_at.
  for (const arr of byKind.values()) {
    arr.sort((a, b) => {
      const ad = Date.parse(a.event_at ?? a.created_at) || 0;
      const bd = Date.parse(b.event_at ?? b.created_at) || 0;
      return bd - ad;
    });
  }
  return byKind;
}

// ─── Top-level component ─────────────────────────────────────────

export function CustomerSignalsSection({
  signals,
}: {
  signals: CustomerSignal[];
}) {
  if (!signals || signals.length === 0) {
    return (
      <section className="bg-surface rounded-xl border border-border shadow-card p-4">
        <h3 className="font-semibold text-fg mb-2">Context & signals</h3>
        <p className="text-sm text-muted">
          No signals posted yet. The{" "}
          <code className="font-mono bg-surface-2 px-1 rounded text-xs">
            enterprise-customer-context
          </code>{" "}
          Claude skill writes here via{" "}
          <code className="font-mono bg-surface-2 px-1 rounded text-xs">
            POST /api/customer-signals
          </code>
          .
        </p>
      </section>
    );
  }

  const byKind = groupSignals(signals);

  return (
    <section className="bg-surface rounded-xl border border-border shadow-card p-4 space-y-5">
      <div className="flex items-baseline justify-between">
        <h3 className="font-semibold text-fg">Context & signals</h3>
        <span className="text-xs text-muted">
          {signals.length} signal{signals.length === 1 ? "" : "s"}
        </span>
      </div>

      {KIND_SECTIONS.map((sec) => {
        const groups = sec.kinds
          .map((kind) => ({ kind, items: byKind.get(kind) ?? [] }))
          .filter((g) => g.items.length > 0);
        if (groups.length === 0) return null;
        return (
          <div key={sec.id} className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
              {sec.title}
            </h4>
            {groups.map(({ kind, items }) => (
              <KindBlock key={kind} kind={kind} items={items} />
            ))}
          </div>
        );
      })}
    </section>
  );
}

// ─── Per-kind dispatch ───────────────────────────────────────────

function KindBlock({
  kind,
  items,
}: {
  kind: SignalKind;
  items: CustomerSignal[];
}) {
  switch (kind) {
    case "customer_overview":
      return <CustomerOverviewBlock items={items} />;
    case "risk_signal":
      return <RiskSignalBlock items={items} />;
    case "action_item":
      return <ActionItemBlock items={items} />;
    case "goal":
      return (
        <RankedBlock
          label="Goals"
          icon="🎯"
          items={items}
          extras={(s) => [
            metaString(s.metadata, "category"),
            metaString(s.metadata, "status"),
          ]}
        />
      );
    case "use_case":
      return (
        <RankedBlock
          label="Interesting use cases"
          icon="💡"
          items={items}
          extras={(s) => [metaString(s.metadata, "summary_long")]}
        />
      );
    case "feature_request":
      return <FeatureRequestBlock items={items} />;
    case "feature_adoption":
      return <FeatureAdoptionBlock items={items} />;
    case "contact_update":
      return <ContactUpdateBlock items={items} />;
    case "touchpoint":
      return <TouchpointBlock items={items} />;
    case "meeting":
    case "note":
    case "win":
    case "context":
      return (
        <GenericListBlock
          label={LEGACY_LABELS[kind]}
          icon={LEGACY_ICONS[kind]}
          items={items}
        />
      );
  }
}

const LEGACY_LABELS: Record<string, string> = {
  meeting: "Meetings",
  note: "Notes",
  win: "Wins",
  context: "Context",
};
const LEGACY_ICONS: Record<string, string> = {
  meeting: "📅",
  note: "📝",
  win: "🏆",
  context: "📌",
};

// ─── Per-kind renderers ──────────────────────────────────────────

function CustomerOverviewBlock({ items }: { items: CustomerSignal[] }) {
  // Skill spec: "latest snapshot per workspace wins" — the upsert path
  // means there should be at most one, but if duplicates ever land we
  // pick the freshest by event_at/created_at.
  const latest = items[0];
  const m = (latest.metadata ?? {}) as MetadataMap;
  const fields: Array<[string, string | null]> = [
    ["Approx active subs", metaString(m, "approx_active_subs")],
    ["Max subscriptions", metaString(m, "max_subscriptions")],
    ["Risk level", metaString(m, "risk_level")],
    ["Engagement", metaString(m, "engagement_score")],
    ["Main contact", metaString(m, "main_contact")],
    ["MRR", metaString(m, "mrr")],
  ];
  const renderable = fields.filter(([, v]) => v != null && v !== "");
  return (
    <div className="bg-canvas/40 border border-border rounded-md p-3 space-y-2">
      {latest.text ? (
        <p className="text-sm text-fg whitespace-pre-wrap">{latest.text}</p>
      ) : null}
      {renderable.length > 0 ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          {renderable.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2">
              <dt className="text-muted">{k}</dt>
              <dd className="text-fg text-right">{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <Footer signal={latest} />
    </div>
  );
}

function RiskSignalBlock({ items }: { items: CustomerSignal[] }) {
  return (
    <BlockHeader label="Risk signals" icon="⚠">
      <ul className="space-y-2">
        {items.map((s) => {
          const m = (s.metadata ?? {}) as MetadataMap;
          const severity = metaString(m, "severity") ?? "medium";
          return (
            <li
              key={s.id}
              className="border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 rounded-md p-3"
            >
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <SeverityChip value={severity} />
                <span className="text-[11px] text-muted">
                  {fmtDate(s.event_at ?? s.created_at)}
                </span>
              </div>
              <p className="text-sm text-fg whitespace-pre-wrap">{s.text}</p>
              {metaString(m, "recommended_action") ? (
                <p className="text-xs text-muted mt-1">
                  <strong className="text-fg">Recommended:</strong>{" "}
                  {metaString(m, "recommended_action")}
                </p>
              ) : null}
              <Footer signal={s} />
            </li>
          );
        })}
      </ul>
    </BlockHeader>
  );
}

function ActionItemBlock({ items }: { items: CustomerSignal[] }) {
  return (
    <BlockHeader label="Action items" icon="✅">
      <ul className="space-y-1.5">
        {items.map((s) => {
          const m = (s.metadata ?? {}) as MetadataMap;
          const status = metaString(m, "status") ?? "open";
          const due = metaString(m, "due_at");
          const owner = metaString(m, "owner");
          const done = status === "resolved";
          return (
            <li
              key={s.id}
              className={`border border-border rounded-md p-2.5 text-sm ${
                done ? "opacity-60" : ""
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <StatusChip
                  value={status}
                  variants={{
                    open: "bg-amber-100 text-amber-800",
                    resolved:
                      "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
                  }}
                />
                <span className="text-[11px] text-muted">
                  {due ? `due ${fmtDate(due)}` : fmtDate(s.event_at ?? s.created_at)}
                </span>
              </div>
              <p
                className={`text-sm mt-1 ${
                  done ? "line-through text-muted" : "text-fg"
                } whitespace-pre-wrap`}
              >
                {metaString(m, "description") ?? s.text}
              </p>
              <Footer
                signal={s}
                extra={owner ? `owner: ${owner}` : undefined}
              />
            </li>
          );
        })}
      </ul>
    </BlockHeader>
  );
}

function RankedBlock({
  label,
  icon,
  items,
  extras,
}: {
  label: string;
  icon: string;
  items: CustomerSignal[];
  extras?: (s: CustomerSignal) => Array<string | null>;
}) {
  // Sort by rank if present (1 best), keep date order otherwise.
  const sorted = [...items].sort((a, b) => {
    const ra = metaNumber(a.metadata, "rank") ?? 99;
    const rb = metaNumber(b.metadata, "rank") ?? 99;
    return ra - rb;
  });
  return (
    <BlockHeader label={label} icon={icon}>
      <ul className="space-y-1.5">
        {sorted.map((s) => {
          const rank = metaNumber(s.metadata, "rank");
          const detail = (extras?.(s) ?? []).filter(Boolean) as string[];
          return (
            <li
              key={s.id}
              className="border border-border rounded-md p-2.5 text-sm"
            >
              <div className="flex items-baseline gap-2">
                {rank ? (
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-semibold bg-surface-2 text-fg">
                    {rank}
                  </span>
                ) : null}
                <p className="flex-1 text-fg whitespace-pre-wrap">{s.text}</p>
              </div>
              {detail.length > 0 ? (
                <p className="text-xs text-muted mt-1">{detail.join(" · ")}</p>
              ) : null}
              <Footer signal={s} />
            </li>
          );
        })}
      </ul>
    </BlockHeader>
  );
}

function FeatureRequestBlock({ items }: { items: CustomerSignal[] }) {
  return (
    <BlockHeader label="Feature requests" icon="🔧">
      <ul className="space-y-1.5">
        {items.map((s) => {
          const m = (s.metadata ?? {}) as MetadataMap;
          const status = metaString(m, "status") ?? "pending";
          const linear = metaString(m, "linear_url");
          return (
            <li
              key={s.id}
              className="border border-border rounded-md p-2.5 text-sm"
            >
              <div className="flex items-baseline justify-between gap-2">
                <StatusChip
                  value={status}
                  variants={{
                    pending: "bg-amber-100 text-amber-800",
                    filed:
                      "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200",
                    comment_added:
                      "bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-200",
                    canceled:
                      "bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-200",
                  }}
                />
                <span className="text-[11px] text-muted">
                  {fmtDate(s.event_at ?? s.created_at)}
                </span>
              </div>
              <p className="text-fg mt-1 whitespace-pre-wrap">
                {metaString(m, "request_summary") ?? s.text}
              </p>
              {linear ? (
                <a
                  href={linear}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline mt-1 inline-block"
                >
                  {linear}
                </a>
              ) : null}
              <Footer signal={s} />
            </li>
          );
        })}
      </ul>
    </BlockHeader>
  );
}

function FeatureAdoptionBlock({ items }: { items: CustomerSignal[] }) {
  return (
    <BlockHeader label="Feature adoption" icon="🚀">
      <ul className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
        {items.map((s) => {
          const m = (s.metadata ?? {}) as MetadataMap;
          const feature = metaString(m, "feature_name") ?? s.text;
          const status = metaString(m, "status") ?? "interest";
          const isNew = metaBool(m, "is_new_feature");
          return (
            <li
              key={s.id}
              className="border border-border rounded-md px-2 py-1.5 text-sm flex items-center justify-between gap-2"
            >
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="text-fg truncate">{feature}</span>
                {isNew ? (
                  <span className="text-[10px] uppercase tracking-wide bg-accent-soft text-accent-fg dark:text-fg px-1 rounded">
                    new
                  </span>
                ) : null}
              </span>
              <StatusChip
                value={status}
                variants={{
                  interest:
                    "bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-200",
                  beta_access:
                    "bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-200",
                  active_use:
                    "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
                  declined:
                    "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200",
                }}
              />
            </li>
          );
        })}
      </ul>
    </BlockHeader>
  );
}

function ContactUpdateBlock({ items }: { items: CustomerSignal[] }) {
  return (
    <BlockHeader label="Contact roster" icon="👥">
      <ul className="space-y-1">
        {items.map((s) => {
          const m = (s.metadata ?? {}) as MetadataMap;
          const name = metaString(m, "name") ?? s.text;
          const role = metaString(m, "role");
          const email = metaString(m, "email");
          const isMain = metaBool(m, "is_main");
          const lastTouch = metaString(m, "last_touch_at");
          return (
            <li
              key={s.id}
              className="border border-border rounded-md p-2 text-sm"
            >
              <div className="flex items-baseline justify-between gap-2 flex-wrap">
                <span className="font-medium text-fg">
                  {name}
                  {isMain ? (
                    <span className="ml-1.5 text-[10px] uppercase tracking-wide bg-accent-soft text-fg px-1 rounded border border-accent">
                      main
                    </span>
                  ) : null}
                </span>
                {role ? (
                  <span className="text-xs text-muted">{role}</span>
                ) : null}
              </div>
              {email ? (
                <a
                  href={`mailto:${email}`}
                  className="text-xs text-muted hover:text-fg break-all"
                >
                  {email}
                </a>
              ) : null}
              {lastTouch ? (
                <p className="text-[11px] text-muted mt-0.5">
                  Last touch {fmtDate(lastTouch)}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </BlockHeader>
  );
}

function TouchpointBlock({ items }: { items: CustomerSignal[] }) {
  return (
    <BlockHeader label="Touchpoints" icon="💬">
      <ul className="space-y-1.5">
        {items.map((s) => {
          const m = (s.metadata ?? {}) as MetadataMap;
          const channel = metaString(m, "channel");
          const direction = metaString(m, "direction");
          const subject = metaString(m, "subject");
          const thread = metaString(m, "thread_url") ?? metaString(m, "recording_url");
          return (
            <li
              key={s.id}
              className="border border-border rounded-md p-2.5 text-sm"
            >
              <div className="flex items-baseline justify-between gap-2 flex-wrap">
                <span className="flex items-center gap-1.5 text-[11px] text-muted">
                  {channel ? (
                    <span className="uppercase tracking-wide font-medium">
                      {channel}
                    </span>
                  ) : null}
                  {direction ? (
                    <span className="text-subtle">· {direction}</span>
                  ) : null}
                </span>
                <span className="text-[11px] text-muted">
                  {fmtDate(s.event_at ?? s.created_at)}
                </span>
              </div>
              {subject ? (
                <p className="text-fg font-medium mt-0.5">{subject}</p>
              ) : null}
              <p className="text-fg whitespace-pre-wrap mt-0.5">{s.text}</p>
              {thread ? (
                <a
                  href={thread}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline mt-1 inline-block"
                >
                  Open thread →
                </a>
              ) : null}
              <Footer signal={s} />
            </li>
          );
        })}
      </ul>
    </BlockHeader>
  );
}

function GenericListBlock({
  label,
  icon,
  items,
}: {
  label: string;
  icon: string;
  items: CustomerSignal[];
}) {
  return (
    <BlockHeader label={label} icon={icon}>
      <ul className="space-y-1.5">
        {items.map((s) => (
          <li key={s.id} className="border border-border rounded-md p-2.5 text-sm">
            <div className="flex items-baseline justify-end gap-2">
              <span className="text-[11px] text-muted">
                {fmtDate(s.event_at ?? s.created_at)}
              </span>
            </div>
            <p className="text-fg whitespace-pre-wrap">{s.text}</p>
            <Footer signal={s} />
          </li>
        ))}
      </ul>
    </BlockHeader>
  );
}

// ─── Shared bits ─────────────────────────────────────────────────

function BlockHeader({
  label,
  icon,
  children,
}: {
  label: string;
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h5 className="text-xs font-semibold text-fg mb-1.5">
        <span aria-hidden className="mr-1">
          {icon}
        </span>
        {label}
      </h5>
      {children}
    </div>
  );
}

function Footer({
  signal,
  extra,
}: {
  signal: CustomerSignal;
  extra?: string;
}) {
  const parts: string[] = [];
  if (signal.created_by) parts.push(signal.created_by);
  if (signal.source && signal.source !== signal.created_by)
    parts.push(signal.source);
  if (extra) parts.push(extra);
  if (parts.length === 0) return null;
  return (
    <p className="text-[10px] text-subtle mt-1">{parts.join(" · ")}</p>
  );
}

function SeverityChip({ value }: { value: string }) {
  const map: Record<string, string> = {
    high: "bg-red-200 text-red-900 dark:bg-red-500/30 dark:text-red-100",
    medium: "bg-amber-200 text-amber-900 dark:bg-amber-500/30 dark:text-amber-100",
    low: "bg-slate-200 text-slate-700 dark:bg-slate-500/30 dark:text-slate-100",
  };
  return (
    <span
      className={`text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded ${
        map[value] ?? map.medium
      }`}
    >
      {value}
    </span>
  );
}

function StatusChip({
  value,
  variants,
}: {
  value: string;
  variants: Record<string, string>;
}) {
  const cls = variants[value] ?? "bg-surface-2 text-muted";
  return (
    <span
      className={`text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded ${cls}`}
    >
      {value.replace(/_/g, " ")}
    </span>
  );
}

// ─── Metadata helpers ────────────────────────────────────────────

function metaString(
  m: Record<string, unknown> | undefined,
  key: string
): string | null {
  if (!m) return null;
  const v = m[key];
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function metaNumber(
  m: Record<string, unknown> | undefined,
  key: string
): number | null {
  if (!m) return null;
  const v = m[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function metaBool(
  m: Record<string, unknown> | undefined,
  key: string
): boolean {
  if (!m) return false;
  const v = m[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() === "true";
  return false;
}
