import { CsmSelector } from "./csm-selector";

/**
 * Standalone CSM dropdown for tabs that don't have a full FilterBar
 * (at-risk, renewals, deliverability). Sits above the tab content.
 */
export function PageCsmFilter({ csms }: { csms: string[] }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <span className="text-xs text-gray-500">CSM:</span>
      <CsmSelector csms={csms} />
    </div>
  );
}
