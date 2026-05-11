import { AdGapPanel } from "@/components/ad-gap-panel";

export default function AdGapPage() {
  return (
    <>
      <div className="mb-6">
        <h1 className="text-3xl font-semibold text-fg tracking-tight">Ad Network Gap</h1>
        <p className="text-sm text-muted mt-1">
          Per-customer portfolio view of fill rate, actual revenue, and
          potential at 100% fill. Mirrors the{" "}
          <code className="bg-surface-2 px-1 py-0.5 rounded">/ad-gap-analysis</code>{" "}
          CSM skill.
        </p>
      </div>
      <AdGapPanel />
    </>
  );
}
