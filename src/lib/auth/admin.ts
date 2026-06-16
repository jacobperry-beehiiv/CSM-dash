/**
 * Admin authz — gates the /admin/team-todos surface (and any future
 * super-admin features). Centralized so the allowlist lives in one
 * place; expanding to multiple admins later is just adding emails to
 * the array (or moving to a settings-backed list).
 *
 * For now: hardcoded single-email allowlist. Easy to expand without
 * a settings migration once we know who else needs admin rights.
 */

const ADMIN_EMAILS: ReadonlySet<string> = new Set([
  "jacob.perry@beehiiv.com",
]);

export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.has(email.trim().toLowerCase());
}

export function listAdminEmails(): string[] {
  return Array.from(ADMIN_EMAILS);
}
