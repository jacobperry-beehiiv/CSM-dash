export function DeliverabilityBanner({ source }: { source: string }) {
  if (source !== "csv" && source !== "mock") return null;
  const label = source === "csv" ? "CSV" : "mock";
  return (
    <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg p-4 text-sm text-amber-900 mb-4">
      Deliverability needs Metabase ClickHouse access — currently in {label} mode,
      so this view runs against the {label} fixture only. Set{" "}
      <code className="px-1 bg-amber-100 rounded">DATA_SOURCE=metabase</code> with
      a valid <code className="px-1 bg-amber-100 rounded">METABASE_API_KEY</code>{" "}
      to load yesterday&apos;s real Enterprise posts.
    </div>
  );
}
