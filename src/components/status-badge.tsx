const colors: Record<string, string> = {
  Live: "bg-green-100 text-green-800",
  Onboarding: "bg-blue-100 text-blue-800 dark:text-blue-300",
  "At Risk": "bg-yellow-100 text-yellow-800",
  Churned: "bg-red-100 text-red-800 dark:text-red-300",
  "Very High Touch": "bg-purple-100 text-purple-800",
  "High Touch": "bg-blue-100 text-blue-800 dark:text-blue-300",
  "Medium Touch": "bg-yellow-100 text-yellow-800",
  "Low Touch": "bg-surface-2 text-fg",
  "No Touch": "bg-canvas text-muted",
};

export function StatusBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-subtle">-</span>;
  const color = colors[value] || "bg-surface-2 text-fg";
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${color}`}>
      {value}
    </span>
  );
}

export function SeverityBadge({
  severity,
}: {
  severity: "critical" | "warning";
}) {
  const cls =
    severity === "critical"
      ? "bg-red-100 text-red-800 dark:text-red-300"
      : "bg-amber-100 text-amber-800 dark:text-amber-300";
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {severity}
    </span>
  );
}
