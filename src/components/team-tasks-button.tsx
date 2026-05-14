"use client";

import { useState } from "react";
import { TeamTasksModal } from "./team-tasks-modal";

/**
 * Header button that opens the shared team-task modal. Lives in the
 * CSM page header so it's reachable from every tab without cluttering
 * the per-tab filter strips.
 */
export function TeamTasksButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 border border-border-strong rounded-md text-sm font-medium hover:bg-canvas inline-flex items-center gap-1.5"
        title="Open the shared team-task list"
      >
        <span aria-hidden>📋</span>
        Team tasks
      </button>
      {open ? <TeamTasksModal onClose={() => setOpen(false)} /> : null}
    </>
  );
}
