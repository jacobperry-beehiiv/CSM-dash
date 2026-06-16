import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/auth/admin";
import { TeamTodosAdmin } from "@/components/admin/team-todos-admin";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Team to-dos (admin) — CSM Mission Control",
};

/**
 * /admin/team-todos
 *
 * Admin-only view of every CSM's personal to-do list. Server component
 * gates on isAdmin() and redirects non-admins to the home page; the
 * actual UI is the TeamTodosAdmin client component which talks to
 * /api/admin/team-todos.
 *
 * Layout: sidebar of CSMs with open-count badges, right pane shows
 * the selected CSM's full list with the same edit affordances as
 * PersonalTodosPanel. Every admin-initiated edit stamps
 * source_meta.admin_acted_by on the to-do (see applyTodoOp's audit
 * hook in personal-todos/store.ts).
 */
export default async function TeamTodosPage() {
  const session = await auth();
  if (!session?.user?.email) {
    redirect("/api/auth/signin");
  }
  if (!isAdmin(session.user.email)) {
    // Quiet redirect — non-admins shouldn't even know this surface
    // exists. The home page is the right landing.
    redirect("/");
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold text-fg tracking-tight">
          Team to-dos
        </h1>
        <p className="text-sm text-muted mt-1">
          Admin view — every CSM&apos;s personal to-do list. Edits stamp an
          audit trail so the owner can see who touched their list.
        </p>
      </div>
      <TeamTodosAdmin viewerEmail={session.user.email} />
    </div>
  );
}
