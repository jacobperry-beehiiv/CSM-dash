import type { Customer } from "@/lib/types";
import { customerFeatures, type FeatureState } from "@/lib/features";

const GROUP_ORDER: Array<"Monetization" | "Growth" | "Onboarding" | "Activity"> = [
  "Monetization",
  "Growth",
  "Onboarding",
  "Activity",
];

const STATE_LABEL: Record<FeatureState, string> = {
  active: "Active",
  inactive: "Not used",
  started: "Started",
  completed: "Completed",
  unknown: "Unknown",
};

const STATE_STYLES: Record<FeatureState, string> = {
  active: "bg-emerald-100 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/30",
  completed: "bg-emerald-100 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/30",
  started: "bg-amber-100 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-500/30",
  inactive: "bg-surface-2 text-muted border-border",
  unknown: "bg-canvas text-subtle border-border",
};

export function FeatureBreakdown({ customer }: { customer: Customer }) {
  const features = customerFeatures(customer);

  const grouped = GROUP_ORDER.map((group) => ({
    group,
    items: features.filter((f) => f.group === group),
  })).filter((g) => g.items.length > 0);

  const active = features.filter(
    (f) => f.state === "active" || f.state === "completed"
  );
  const inactive = features.filter(
    (f) => f.state === "inactive" || f.state === "started"
  );

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-4 text-sm">
        <span className="font-medium text-fg">
          {customer.company_name ?? customer.workspace_name}
        </span>
        <span className="text-muted">
          {active.length} active · {inactive.length} not in use or started
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {grouped.map(({ group, items }) => (
          <div
            key={group}
            className="rounded-md border border-border bg-surface p-3"
          >
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">
              {group}
            </h4>
            <ul className="space-y-1.5">
              {items.map((f) => (
                <li key={f.key} className="flex items-start gap-2 text-sm">
                  <StateChip state={f.state} />
                  <div className="flex-1 min-w-0">
                    <div
                      className={
                        f.state === "active" || f.state === "completed"
                          ? "text-fg"
                          : f.state === "unknown"
                            ? "text-subtle italic"
                            : "text-muted"
                      }
                    >
                      {f.label}
                    </div>
                    {f.detail ? (
                      <div className="text-xs text-muted mt-0.5">
                        {f.detail}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function StateChip({ state }: { state: FeatureState }) {
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border whitespace-nowrap ${STATE_STYLES[state]}`}
    >
      {STATE_LABEL[state]}
    </span>
  );
}
