import { auth } from "@/auth";
import { TeamTodosAdmin } from "@/components/admin/team-todos-admin";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Team to-dos (admin) — CSM Mission Control",
};

/**
 * /admin/team-todos
 *
 * Admin-only view of every CSM's personal to-do list. The admin gate
 * is enforced by the parent /admin layout — by the time this page
 * renders, `session.user.email` is guaranteed to be an admin.
 *
 * The actual UI is the TeamTodosAdmin client component which talks
 * to /api/admin/team-todos. Every admin-initiated edit stamps
 * source_meta.admin_acted_by on the to-do (see applyTodoOp's audit
 * hook in personal-todos/store.ts).
 */
export default async function TeamTodosPage() {
  const session = await auth();
  // Layout already gated; non-null assertion is safe here.
  const viewerEmail = session?.user?.email ?? "";

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-fg">Team to-dos</h2>
        <p className="text-sm text-muted mt-1">
          Every CSM&apos;s personal to-do list. Edits stamp an audit
          trail so the owner can see who touched their list.
        </p>
      </div>
      <TeamTodosAdmin viewerEmail={viewerEmail} />
    </div>
  );
}
