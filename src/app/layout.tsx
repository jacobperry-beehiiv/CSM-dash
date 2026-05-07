import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

import { dataSourceMeta } from "@/lib/data/load-customers";
import { SnapshotBanner } from "@/components/snapshot-banner";

export const metadata: Metadata = {
  title: "CSM Mission Control — beehiiv",
  description: "Customer success operational dashboard",
};

const NAV = [
  { href: "/csm", label: "CSM Dashboard" },
  { href: "/am", label: "AM Dashboard" },
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

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">
        <header className="border-b border-gray-200 bg-white sticky top-0 z-20">
          <div className="max-w-[1400px] mx-auto px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-6">
              <Link href="/" className="font-semibold text-gray-900 whitespace-nowrap">
                CSM Mission Control
              </Link>
              <nav className="flex items-center gap-4 text-sm">
                {NAV.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    className="text-gray-600 hover:text-gray-900"
                  >
                    {n.label}
                  </Link>
                ))}
              </nav>
            </div>
            <SnapshotMeta />
          </div>
        </header>
        <main className="max-w-[1400px] mx-auto px-6 py-6">{children}</main>
      </body>
    </html>
  );
}
