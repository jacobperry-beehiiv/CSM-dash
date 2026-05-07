const colors: Record<string, string> = {
  Live: "bg-green-100 text-green-800",
  Onboarding: "bg-blue-100 text-blue-800",
  "At Risk": "bg-yellow-100 text-yellow-800",
  Churned: "bg-red-100 text-red-800",
  "Very High Touch": "bg-purple-100 text-purple-800",
  "High Touch": "bg-blue-100 text-blue-800",
  "Medium Touch": "bg-yellow-100 text-yellow-800",
  "Low Touch": "bg-gray-100 text-gray-800",
  "No Touch": "bg-gray-50 text-gray-500",
};

export function StatusBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-gray-400">-</span>;
  const color = colors[value] || "bg-gray-100 text-gray-800";
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
      ? "bg-red-100 text-red-800"
      : "bg-amber-100 text-amber-800";
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {severity}
    </span>
  );
}
