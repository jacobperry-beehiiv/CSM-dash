interface Props {
  level: string | null | undefined;
  detail?: string | null;
}

const STYLES: Record<string, string> = {
  red: "bg-red-100 text-red-800 border-red-200",
  yellow: "bg-amber-100 text-amber-800 border-amber-200",
  "light green": "bg-emerald-50 text-emerald-700 border-emerald-200",
  green: "bg-green-100 text-green-800 border-green-200",
};

export function RiskLevelChip({ level, detail }: Props) {
  if (!level) return <span className="text-gray-300">—</span>;
  const key = level.toLowerCase().trim();
  const cls = STYLES[key] ?? "bg-gray-100 text-gray-800 border-gray-200";
  return (
    <span
      title={detail ?? undefined}
      className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border whitespace-nowrap ${cls}`}
    >
      {level}
    </span>
  );
}
