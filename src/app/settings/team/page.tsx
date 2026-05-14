import { getTeamTasks } from "@/lib/team-tasks/store";
import { TeamRosterEditor } from "@/components/team-roster-editor";

export const dynamic = "force-dynamic";

/**
 * Settings → Team. Admin-edits the roster that populates the open-asks
 * tracker on the mission-control root page. Reads the current roster
 * server-side then hands it off to the client-side editor for autosave.
 */
export default async function TeamSettingsPage() {
  const { members } = await getTeamTasks();
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-fg tracking-tight">Team</h2>
        <p className="text-sm text-muted mt-1">
          The people who appear as columns on the open-asks tracker.
        </p>
      </div>
      <TeamRosterEditor initial={members} />
    </div>
  );
}
