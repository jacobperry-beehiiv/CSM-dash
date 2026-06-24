import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/auth/admin";
import { AdminSidebar } from "@/components/admin/admin-sidebar";

export const metadata = {
  title: "Super Admin — CSM Mission Control",
};

/**
 * /admin/* layout — Super Admin landing.
 *
 * Single admin-gate enforced at the layout level instead of inside
 * each page so adding a new admin surface is just dropping
 * src/app/admin/<thing>/page.tsx + an entry in AdminSidebar. The
 * gate redirects non-admins quietly to the home page — they
 * shouldn't even see the surface exists.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.email) {
    redirect("/api/auth/signin");
  }
  if (!isAdmin(session.user.email)) {
    redirect("/");
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-3xl font-semibold text-fg tracking-tight">
          Super Admin
        </h1>
        <p className="text-sm text-muted mt-1">
          Restricted controls — feature gates, team admin surfaces.
          Visible only to listed super-admins (see{" "}
          <code className="font-mono bg-surface-2 px-1 rounded text-[12px]">
            src/lib/auth/admin.ts
          </code>
          ).
        </p>
      </div>
      <div className="flex flex-col md:flex-row gap-6">
        <AdminSidebar />
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </>
  );
}
