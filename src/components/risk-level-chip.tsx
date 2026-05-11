interface Props {
  level: string | null | undefined;
  detail?: string | null;
}

const STYLES: Record<string, string> = {
  red: "bg-red-100 text-red-800 dark:text-red-300 border-red-200 dark:border-red-500/30",
  yellow: "bg-amber-100 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-500/30",
  "light green": "bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/30",
  green: "bg-green-100 text-green-800 border-green-200",
};

export function RiskLevelChip({ level, detail }: Props) {
  if (!level) return <span className="text-subtle">—</span>;
  const key = level.toLowerCase().trim();
  const cls = STYLES[key] ?? "bg-surface-2 text-fg border-border";
  return (
    <span
      title={detail ?? undefined}
      className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border whitespace-nowrap ${cls}`}
    >
      {level}
    </span>
  );
}
