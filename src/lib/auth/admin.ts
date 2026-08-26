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
  "richard@beehiiv.com",
]);

export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.has(email.trim().toLowerCase());
}

export function listAdminEmails(): string[] {
  return Array.from(ADMIN_EMAILS);
}

/**
 * Separate, narrower allowlist for managing the shared Prior ESP /
 * Tech Stack option lists at /settings/profile-fields. Kept distinct
 * from ADMIN_EMAILS on purpose: being able to curate these dropdowns
 * shouldn't grant the full super-admin surface (team-todos, flags),
 * and vice-versa. Expand by adding emails here.
 */
const PROFILE_OPTIONS_ADMINS: ReadonlySet<string> = new Set([
  "juliet@beehiiv.com",
  "jacob.perry@beehiiv.com",
]);

export function isProfileOptionsAdmin(
  email: string | null | undefined
): boolean {
  if (!email) return false;
  return PROFILE_OPTIONS_ADMINS.has(email.trim().toLowerCase());
}
