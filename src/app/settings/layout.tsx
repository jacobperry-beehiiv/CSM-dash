import { Suspense } from "react";
import { SettingsSidebar } from "@/components/settings-sidebar";

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="text-sm text-gray-500 mt-1">
          App-wide tunables — at-risk thresholds, outreach templates, and the
          Enterprise tier ladder.
        </p>
      </div>
      <div className="flex flex-col md:flex-row gap-6">
        <Suspense fallback={<div className="md:w-56 md:shrink-0" />}>
          <SettingsSidebar />
        </Suspense>
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </>
  );
}
