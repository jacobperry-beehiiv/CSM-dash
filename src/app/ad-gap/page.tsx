import { AdGapPanel } from "@/components/ad-gap-panel";

export default function AdGapPage() {
  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Ad Network Gap</h1>
        <p className="text-sm text-gray-500 mt-1">
          Per-customer portfolio view of fill rate, actual revenue, and
          potential at 100% fill. Mirrors the{" "}
          <code className="bg-gray-100 px-1 py-0.5 rounded">/ad-gap-analysis</code>{" "}
          CSM skill.
        </p>
      </div>
      <AdGapPanel />
    </>
  );
}
