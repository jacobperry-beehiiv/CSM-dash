import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

import { dataSourceMeta } from "@/lib/data/load-customers";
import { SnapshotBanner } from "@/components/snapshot-banner";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/user-menu";
import { BeehiivLogo } from "@/components/beehiiv-logo";
import { ReportIssueButton } from "@/components/report-issue-button";
import {
  BusinessModeToggle,
  PersonalizationProvider,
} from "@/components/personalization-provider";
import { PersonalizedHeader } from "@/components/personalized-header";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/auth/admin";
import { isCsmWithGmail } from "@/lib/auth/csm-eligibility";
import { loadPersonalization } from "@/lib/data/personalization";

const DEFAULT_TITLE = "CSM Mission Control — beehiiv";

/** Dynamic per-request metadata so a personalized dashboard name
 *  shows up in the browser tab title. Falls back to the default when
 *  the viewer isn't eligible or hasn't set a name. */
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) return { title: DEFAULT_TITLE };
  if (!(await isCsmWithGmail(email))) return { title: DEFAULT_TITLE };
  const p = await loadPersonalization(email);
  const name = p?.dashboard_name?.trim();
  return {
    title: name ? `${name} — beehiiv` : DEFAULT_TITLE,
    description: "Customer success operational dashboard",
  };
}

const NAV = [
  { href: "/csm", label: "CSM" },
  { href: "/am", label: "AM" },
  { href: "/ad-gap", label: "Ad Gap" },
  { href: "/feature-requests", label: "Feature requests" },
  { href: "/settings", label: "Settings" },
];

/** Nav entries that only render for admins (isAdmin → true). Today
 *  just the team-todos view; gate via the same helper any future
 *  admin-only surfaces should share. */
const ADMIN_NAV = [{ href: "/admin/team-todos", label: "Team to-dos" }];

async function SnapshotMeta() {
  const meta = await dataSourceMeta();
  if (meta.source !== "snapshot") return null;
  return (
    <SnapshotBanner generatedAt={meta.generatedAt} rowCount={meta.rowCount} />
  );
}

// Inline blocking script — sets the `dark` class on <html> before paint so
// users don't see a flash of light mode while React hydrates.
const themeInit = `
try {
  var t = localStorage.getItem("theme");
  var d = t === "dark" || (!t && window.matchMedia("(prefers-color-scheme: dark)").matches);
  if (d) document.documentElement.classList.add("dark");
} catch (e) {}
`;

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await auth();
  const viewerIsAdmin = isAdmin(session?.user?.email);
  const nav = viewerIsAdmin ? [...NAV, ...ADMIN_NAV] : NAV;
  // Per-user personalization — only resolved when the viewer is a
  // CSM with Gmail connected. Otherwise the provider gets `null` and
  // the page renders defaults regardless of what's in KV.
  const viewerEmail = session?.user?.email ?? null;
  const personalization =
    viewerEmail && (await isCsmWithGmail(viewerEmail))
      ? await loadPersonalization(viewerEmail)
      : null;
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        {/* Self-hosted-friendly font CDN. Satoshi powers body text;
            Clash Grotesk powers headings. Both come from Fontshare
            (Indian Type Foundry) — free for commercial use. */}
        <link
          rel="preconnect"
          href="https://api.fontshare.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&f[]=clash-grotesk@400,500,600,700&display=swap"
          rel="stylesheet"
        />
        {/* Optional personalization fonts. Loaded for everyone (so a
            CSM's chosen font is ready the moment their override
            applies) but unused until their personalization injects
            them via --font-sans. Kept narrow so the layout doesn't
            bloat — see FONT_OPTIONS for the curated list. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&family=Outfit:wght@400;500;700&family=Space+Grotesk:wght@400;500;700&family=Lora:wght@400;500;700&family=JetBrains+Mono:wght@400;500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-full bg-canvas text-fg">
        <PersonalizationProvider initial={personalization}>
          <header className="border-b border-border bg-canvas/85 backdrop-blur-md sticky top-0 z-20">
            <div className="max-w-[1400px] mx-auto px-6 h-16 flex items-center justify-between gap-4">
              <div className="flex items-center gap-10">
                <Link
                  href="/"
                  aria-label="Mission Control — home"
                  className="text-fg hover:opacity-80 transition-opacity flex items-center gap-2"
                >
                  <PersonalizedHeader
                    fallbackLogo={<BeehiivLogo className="h-7 w-7" />}
                  />
                </Link>
                <nav className="flex items-center gap-6 text-[13.5px]">
                  {nav.map((n) => (
                    <Link
                      key={n.href}
                      href={n.href}
                      className="text-muted hover:text-fg transition-colors"
                    >
                      {n.label}
                    </Link>
                  ))}
                </nav>
              </div>
              <div className="flex items-center gap-3">
                <SnapshotMeta />
                <BusinessModeToggle />
                <ThemeToggle />
                <UserMenu />
              </div>
            </div>
          </header>
          <main className="max-w-[1400px] mx-auto px-6 py-10">{children}</main>
          {/* Site-wide "Report an issue" floating button. Hides itself
              when no viewer is signed in (handled inside the component
              via useViewerEmail), so the login page chrome stays clean. */}
          <ReportIssueButton />
        </PersonalizationProvider>
      </body>
    </html>
  );
}
