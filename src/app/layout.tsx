import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

import { dataSourceMeta } from "@/lib/data/load-customers";
import { SnapshotBanner } from "@/components/snapshot-banner";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/user-menu";
import { BeehiivLogo } from "@/components/beehiiv-logo";

export const metadata: Metadata = {
  title: "CSM Mission Control — beehiiv",
  description: "Customer success operational dashboard",
};

const NAV = [
  { href: "/csm", label: "CSM" },
  { href: "/am", label: "AM" },
  { href: "/ad-gap", label: "Ad Gap" },
  { href: "/settings", label: "Settings" },
];

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

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
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
      </head>
      <body className="min-h-full bg-canvas text-fg">
        <header className="border-b border-border bg-canvas/85 backdrop-blur-md sticky top-0 z-20">
          <div className="max-w-[1400px] mx-auto px-6 h-16 flex items-center justify-between gap-4">
            <div className="flex items-center gap-10">
              <Link
                href="/"
                aria-label="Mission Control — home"
                className="text-fg hover:opacity-80 transition-opacity"
              >
                <BeehiivLogo className="h-7 w-7" />
              </Link>
              <nav className="flex items-center gap-6 text-[13.5px]">
                {NAV.map((n) => (
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
              <ThemeToggle />
              <UserMenu />
            </div>
          </div>
        </header>
        <main className="max-w-[1400px] mx-auto px-6 py-10">{children}</main>
      </body>
    </html>
  );
}
