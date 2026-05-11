"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

interface Status {
  connected: boolean;
  email: string | null;
  scope: string | null;
  connected_emails: string[];
}

function GmailSettingsInner() {
  const params = useSearchParams();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const justConnected = params.get("gmail_connected") === "1";
  const errParam = params.get("gmail_error");

  async function refresh() {
    const r = await fetch("/api/auth/google/status");
    if (r.ok) setStatus(await r.json());
  }

  useEffect(() => {
    refresh();
  }, []);

  async function disconnect(everywhere: boolean) {
    const msg = everywhere
      ? "Forget this Gmail connection completely (revoke from disk)? Drafts already created will not be removed. The same CSM can re-connect later via OAuth."
      : "Sign out of this browser? The Gmail token stays on disk so you (or another CSM on a different browser) can switch back to it without re-authenticating.";
    if (!confirm(msg)) return;
    setBusy(true);
    setMessage(null);
    try {
      const url = everywhere
        ? "/api/auth/google/status?everywhere=1"
        : "/api/auth/google/status";
      await fetch(url, { method: "DELETE" });
      await refresh();
      setMessage(everywhere ? "Disconnected and forgot token." : "Signed out.");
    } finally {
      setBusy(false);
    }
  }

  async function switchTo(email: string) {
    setBusy(true);
    setMessage(null);
    try {
      const r = await fetch("/api/auth/google/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      await refresh();
      setMessage(`Switched to ${email}.`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Switch failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="bg-surface rounded-xl border border-border shadow-card p-4 space-y-3">
        <h2 className="text-sm font-semibold text-fg">
          Your Gmail connection
        </h2>
        <p className="text-xs text-muted">
          Each CSM connects their own Google account. Drafts created from
          this browser land in <strong>your</strong> Gmail Drafts folder —
          never anyone else&rsquo;s. The connection is identified by a
          per-browser session cookie, so signing out of one browser
          doesn&rsquo;t affect another. Scope:{" "}
          <code className="font-mono px-1 bg-surface-2 rounded">
            gmail.compose
          </code>{" "}
          (drafts only — the dashboard cannot send mail on your behalf).
        </p>

        {errParam ? (
          <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-md p-3 text-sm text-red-800 dark:text-red-300">
            OAuth error: <code className="font-mono">{errParam}</code>
          </div>
        ) : null}
        {justConnected ? (
          <div className="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 rounded-md p-3 text-sm text-emerald-800 dark:text-emerald-300">
            Connected ✓
          </div>
        ) : null}
        {message ? (
          <div className="bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-accent/30 rounded-md p-3 text-sm text-blue-800 dark:text-blue-300">
            {message}
          </div>
        ) : null}

        {status === null ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : status.connected ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
              This browser is signed in as{" "}
              <strong className="font-mono">{status.email}</strong>
            </div>
            {status.scope ? (
              <p className="text-[11px] text-muted break-all">
                Scopes: {status.scope}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <a
                href="/api/auth/google/start"
                className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas"
              >
                Connect a different account
              </a>
              <button
                onClick={() => disconnect(false)}
                disabled={busy}
                className="px-3 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas disabled:opacity-50"
              >
                Sign out of this browser
              </button>
              <button
                onClick={() => disconnect(true)}
                disabled={busy}
                className="px-3 py-1.5 border border-red-300 text-red-700 rounded-md text-sm hover:bg-red-50 dark:bg-red-500/10 disabled:opacity-50"
                title="Removes the token from disk so it can no longer be used to create drafts."
              >
                Disconnect &amp; forget
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <span className="inline-block w-2 h-2 rounded-full bg-gray-300" />
              This browser isn&rsquo;t signed in.
            </div>
            <a
              href="/api/auth/google/start"
              className="inline-block px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover"
            >
              Connect Gmail
            </a>
          </div>
        )}
      </section>

      {status && status.connected_emails.length > 0 ? (
        <section className="bg-surface rounded-xl border border-border shadow-card p-4 space-y-2">
          <h2 className="text-sm font-semibold text-fg">
            Other connected accounts on this server
          </h2>
          <p className="text-xs text-muted">
            Tokens for these accounts are saved on disk. Switching takes
            effect for this browser only — drafts will be created in the
            chosen mailbox.
          </p>
          <ul className="divide-y divide-border">
            {status.connected_emails.map((email) => {
              const active = email === status.email;
              return (
                <li
                  key={email}
                  className="flex items-center justify-between py-2 text-sm"
                >
                  <span className="font-mono text-fg">{email}</span>
                  <button
                    onClick={() => (active ? null : switchTo(email))}
                    disabled={busy || active}
                    className={`px-2 py-1 text-xs rounded-md border ${
                      active
                        ? "bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
                        : "border-border-strong hover:bg-canvas"
                    }`}
                  >
                    {active ? "Active" : "Switch"}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="bg-surface rounded-xl border border-border shadow-card p-4 space-y-2">
        <h2 className="text-sm font-semibold text-fg">
          First-time setup (admin only — one per deployment)
        </h2>
        <ol className="list-decimal list-inside text-sm text-muted space-y-1">
          <li>
            Create an OAuth 2.0 Client ID in{" "}
            <a
              href="https://console.cloud.google.com/apis/credentials"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              Google Cloud Console &rarr; Credentials
            </a>
            . Application type: <strong>Web application</strong>.
          </li>
          <li>
            Add{" "}
            <code className="font-mono px-1 bg-surface-2 rounded">
              http://localhost:3000/api/auth/google/callback
            </code>{" "}
            (and any deployed URLs) to{" "}
            <strong>Authorized redirect URIs</strong>.
          </li>
          <li>
            Drop{" "}
            <code className="font-mono px-1 bg-surface-2 rounded">
              GOOGLE_CLIENT_ID
            </code>{" "}
            +{" "}
            <code className="font-mono px-1 bg-surface-2 rounded">
              GOOGLE_CLIENT_SECRET
            </code>{" "}
            into{" "}
            <code className="font-mono px-1 bg-surface-2 rounded">
              .env.local
            </code>
            , restart the dev server.
          </li>
          <li>
            On the OAuth consent screen, add the{" "}
            <code className="font-mono px-1 bg-surface-2 rounded">
              gmail.compose
            </code>{" "}
            scope. If your project is in <em>Testing</em>, add each CSM as a
            Test User. (Or push the app to Production for company-wide
            access.)
          </li>
          <li>Each CSM clicks Connect Gmail above to grant their own consent.</li>
        </ol>
      </section>
    </div>
  );
}

export default function GmailSettingsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
      <GmailSettingsInner />
    </Suspense>
  );
}
