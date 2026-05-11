import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";

export const dynamic = "force-dynamic";

interface SP {
  from?: string;
  error?: string;
  callbackUrl?: string;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const session = await auth();
  const sp = await searchParams;
  if (session) redirect(sp.from ?? "/");

  const isAccessDenied =
    sp.error === "AccessDenied" || sp.error === "Verification";
  const callbackUrl = sp.from ?? sp.callbackUrl ?? "/";

  return (
    <div className="min-h-[80vh] flex items-center justify-center px-6">
      <div className="w-full max-w-md bg-surface border border-border rounded-2xl shadow-card-lg p-8 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-fg tracking-tight">
            Mission Control
          </h1>
          <p className="text-sm text-muted mt-1">
            Sign in with your beehiiv Google account to continue.
          </p>
        </div>

        {isAccessDenied ? (
          <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-md p-3 text-sm text-red-800 dark:text-red-300">
            That Google account isn&rsquo;t in the <strong>@beehiiv.com</strong>{" "}
            domain. Sign in with your work account.
          </div>
        ) : null}

        <Suspense fallback={null}>
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: callbackUrl });
            }}
          >
            <button
              type="submit"
              className="w-full inline-flex items-center justify-center gap-3 px-4 py-2.5 rounded-lg border border-border-strong bg-surface hover:bg-surface-2 text-fg font-medium"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
                <path
                  fill="#4285F4"
                  d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.84 2.08-1.8 2.72v2.27h2.92c1.71-1.57 2.68-3.88 2.68-6.63z"
                />
                <path
                  fill="#34A853"
                  d="M9 18c2.43 0 4.47-.8 5.96-2.17l-2.92-2.27c-.8.54-1.83.87-3.04.87-2.34 0-4.32-1.58-5.03-3.7H.94v2.32C2.42 15.98 5.46 18 9 18z"
                />
                <path
                  fill="#FBBC05"
                  d="M3.97 10.73c-.18-.54-.28-1.12-.28-1.73s.1-1.19.28-1.73V4.95H.94C.34 6.16 0 7.55 0 9s.34 2.84.94 4.05l3.03-2.32z"
                />
                <path
                  fill="#EA4335"
                  d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.42 0 9 0 5.46 0 2.42 2.02.94 4.95l3.03 2.32C4.68 5.16 6.66 3.58 9 3.58z"
                />
              </svg>
              Continue with Google
            </button>
          </form>
        </Suspense>

        <p className="text-xs text-subtle text-center">
          Access is restricted to the <code className="font-mono">@beehiiv.com</code> domain.
        </p>
      </div>
    </div>
  );
}
