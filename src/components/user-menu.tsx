import { auth, signOut } from "@/auth";

/**
 * Header user pill. Server component so we don't ship the email to clients
 * via a useSession hook — the session lives in an httpOnly cookie and is
 * read once on the server per request.
 */
export async function UserMenu() {
  const session = await auth();
  if (!session?.user?.email) return null;

  const email = session.user.email;
  const initials = email
    .split("@")[0]
    .split(/[._-]/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <form
      action={async () => {
        "use server";
        await signOut({ redirectTo: "/login" });
      }}
      className="flex items-center gap-2"
      title={email}
    >
      <span
        className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-surface-2 border border-border text-[11px] font-semibold text-muted"
        aria-hidden
      >
        {initials || "·"}
      </span>
      <button
        type="submit"
        className="text-[12.5px] text-muted hover:text-fg"
        title={`Sign out (${email})`}
      >
        Sign out
      </button>
    </form>
  );
}
