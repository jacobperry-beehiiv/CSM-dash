import { redirect } from "next/navigation";

// /admin lands on Feature flags as the canonical first section. The
// layout's admin-gate already redirects non-admins away, so this
// page is unreachable to anyone unauthorized.
export default function AdminIndex() {
  redirect("/admin/flags");
}
