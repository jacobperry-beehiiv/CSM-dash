"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

interface Status {
  connected: boolean;
  email: string | null;
  scope: string | null;
  connected_emails: string[];
}

interface AccountAliasRow {
  email: string;
  aliases?: Array<{
    email: string;
    name: string | null;
    is_default: boolean;
    is_primary: boolean;
  }>;
  error?: string;
  needs_reconsent?: boolean;
}

interface AllAliasesResponse {
  accounts: AccountAliasRow[];
}

function GmailSettingsInner() {
  const params = useSearchParams();
  const [status, setStatus] = useState<Status | null>(null);
  // Per-connection alias list. Lets a CSM (or admin debugging
  // someone else's connection) see which Gmail account holds which
  // alias. When Richard's alias isn't showing up in the template
  // editor, he can spot here whether (a) it's on a different
  // connection, (b) his connection needs reconsent for the new
  // scope, or (c) Gmail just doesn't know about it.
  const [aliases, setAliases] = useState<AccountAliasRow[] | null>(null);
  // Captures a 5xx / network failure on /api/auth/google/aliases-all
  // so the UI never gets stuck on "Looking up…" indefinitely. Each
  // connected account row will fall back to a generic error display
  // when this is set.
  const [aliasesError, setAliasesError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Inline two-step confirm for the disconnect buttons. window.confirm()
  // is silently suppressed in the Vercel-hosted browser context, same as
  // the mascot remove / template delete / Primary Company removal flows.
  const [confirming, setConfirming] = useState<null | "signout" | "forget">(
    null
  );
  const justConnected = params.get("gmail_connected") === "1";
  const errParam = params.get("gmail_error");

  async function refresh() {
    const r = await fetch("/api/auth/google/status");
    if (r.ok) setStatus(await r.json());
    // Aliases are independent of status — fire alongside so the
    // section below populates without a second user action.
    try {
      const a = await fetch("/api/auth/google/aliases-all");
      if (a.ok) {
        const j = (await a.json()) as AllAliasesResponse;
        setAliases(j.accounts ?? []);
        setAliasesError(null);
      } else {
        // Non-2xx: set aliases to [] so AliasList drops out of its
        // "Looking up…" branch, and stash the error message for
        // display under each row.
        const body = (await a.json().catch(() => ({}))) as {
          error?: string;
        };
        setAliases([]);
        setAliasesError(
          body.error ?? `Alias lookup failed (HTTP ${a.status})`
        );
      }
    } catch (e) {
      setAliases([]);
      setAliasesError(
        e instanceof Error ? e.message : "Alias lookup network error"
      );
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function attemptDisconnect(everywhere: boolean) {
    const kind = everywhere ? "forget" : "signout";
    if (confirming !== kind) {
      setConfirming(kind);
      return;
    }
    void disconnect(everywhere);
  }

  async function disconnect(everywhere: boolean) {
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
      setConfirming(null);
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
                onClick={() => attemptDisconnect(false)}
                disabled={busy}
                className={`px-3 py-1.5 rounded-md text-sm border disabled:opacity-50 ${
                  confirming === "signout"
                    ? "bg-amber-600 text-white border-amber-600 hover:bg-amber-700"
                    : "border-border-strong hover:bg-canvas"
                }`}
              >
                {busy && confirming === "signout"
                  ? "Signing out…"
                  : confirming === "signout"
                  ? "Confirm sign out"
                  : "Sign out of this browser"}
              </button>
              <button
                onClick={() => attemptDisconnect(true)}
                disabled={busy}
                className={`px-3 py-1.5 rounded-md text-sm border disabled:opacity-50 ${
                  confirming === "forget"
                    ? "bg-red-600 text-white border-red-600 hover:bg-red-700"
                    : "border-red-300 text-red-700 hover:bg-red-50 dark:bg-red-500/10"
                }`}
                title="Removes the token from disk so it can no longer be used to create drafts."
              >
                {busy && confirming === "forget"
                  ? "Forgetting…"
                  : confirming === "forget"
                  ? "Confirm disconnect & forget"
                  : "Disconnect & forget"}
              </button>
              {confirming && !busy ? (
                <button
                  type="button"
                  onClick={() => setConfirming(null)}
                  className="px-2 py-1.5 text-sm text-muted hover:text-fg"
                >
                  Cancel
                </button>
              ) : null}
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
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-sm font-semibold text-fg">
              Connected accounts &amp; their send-as aliases
            </h2>
            <button
              type="button"
              onClick={() => {
                setAliases(null);
                setAliasesError(null);
                void refresh();
              }}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              ↻ Refresh
            </button>
          </div>
          <p className="text-xs text-muted">
            Tokens for these accounts are saved on disk. Switching takes
            effect for this browser only — drafts will be created in
            the chosen mailbox. The alias list under each account is
            what shows up in the template editor&rsquo;s &ldquo;Send
            as&rdquo; dropdown when that account is active.
          </p>
          {aliasesError ? (
            <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-md p-2 text-[11px] text-red-800 dark:text-red-300">
              Alias lookup failed: {aliasesError}. Click ↻ Refresh above
              to retry. If this keeps happening, check the server logs
              for <code className="font-mono">[gmail-aliases]</code>
              entries.
            </div>
          ) : null}
          <ul className="divide-y divide-border">
            {status.connected_emails.map((email) => {
              const active = email === status.email;
              const aliasRow = aliases?.find((a) => a.email === email);
              return (
                <li key={email} className="py-3 space-y-2">
                  <div className="flex items-center justify-between text-sm">
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
                  </div>
                  <AliasList row={aliasRow} loading={aliases === null} />
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

      <section className="bg-surface rounded-xl border border-border shadow-card p-4 space-y-2">
        <h2 className="text-sm font-semibold text-fg">
          Enable alias auto-discovery (admin only)
        </h2>
        <p className="text-sm text-muted">
          The template editor&rsquo;s &ldquo;Send as&rdquo; dropdown
          pulls from each CSM&rsquo;s verified Gmail aliases via{" "}
          <code className="font-mono px-1 bg-surface-2 rounded">
            users.settings.sendAs.list
          </code>
          . That requires the{" "}
          <code className="font-mono px-1 bg-surface-2 rounded">
            gmail.settings.basic
          </code>{" "}
          scope (the minimum-privilege scope the Gmail API exposes for
          reading sendAs settings — there is no{" "}
          <code className="font-mono">gmail.settings.readonly</code>
          ). Google rejects the OAuth flow with{" "}
          <em>Error 400: invalid_scope</em> until the project&rsquo;s
          consent screen lists it. One-time setup:
        </p>
        <ol className="list-decimal list-inside text-sm text-muted space-y-1">
          <li>
            Open{" "}
            <a
              href="https://console.cloud.google.com/apis/credentials/consent"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              Google Cloud Console &rarr; OAuth consent screen
            </a>{" "}
            for this project.
          </li>
          <li>
            Edit the app &rarr; <strong>Data Access</strong> step &rarr;
            click <strong>Add or Remove Scopes</strong>.
          </li>
          <li>
            Search for{" "}
            <code className="font-mono px-1 bg-surface-2 rounded">
              gmail.settings.basic
            </code>{" "}
            (full URI:{" "}
            <code className="font-mono px-1 bg-surface-2 rounded">
              https://www.googleapis.com/auth/gmail.settings.basic
            </code>
            ), check the box, click <strong>Update</strong>, then{" "}
            <strong>Save and Continue</strong> through the rest of the
            wizard. Despite the name, Google&rsquo;s scope picker
            doesn&rsquo;t carry a separate &ldquo;readonly&rdquo;
            variant — <code className="font-mono">basic</code> is the
            right pick.
          </li>
          <li>
            Existing connections need to reconnect once via{" "}
            <code className="font-mono px-1 bg-surface-2 rounded">
              /api/auth/google/start
            </code>{" "}
            to grant the new scope. Users blocked by the consent screen
            change can use the{" "}
            <a
              href="/api/auth/google/start?minimal=1"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              minimal reconnect
            </a>{" "}
            in the meantime — drafts work, alias picker stays empty
            until they reconnect with the full scope set.
          </li>
        </ol>
      </section>
    </div>
  );
}

/** Per-account alias display used inside the connections list. Renders
 *  one of four states: still loading, reconsent needed, generic error,
 *  or the actual chip list. */
function AliasList({
  row,
  loading,
}: {
  row: AccountAliasRow | undefined;
  loading: boolean;
}) {
  if (loading || !row) {
    return (
      <p className="text-[11px] text-muted pl-2 border-l-2 border-border">
        Looking up send-as aliases…
      </p>
    );
  }
  if (row.needs_reconsent) {
    return (
      <div className="pl-2 border-l-2 border-amber-300 text-[11px] text-amber-900 dark:text-amber-200 bg-amber-50 dark:bg-amber-500/10 rounded-r-md p-2 space-y-1.5">
        <div>
          Gmail didn&rsquo;t grant the{" "}
          <code className="font-mono">gmail.settings.basic</code> scope
          for this account — its aliases can&rsquo;t be auto-discovered.{" "}
          <a href="/api/auth/google/start" className="underline font-medium">
            Reconnect this account
          </a>{" "}
          to enable the picker.
        </div>
        <div className="text-[10px] opacity-80">
          If reconnect fails with <em>Error 400: invalid_scope</em>, the
          Google Cloud OAuth consent screen for this project doesn&rsquo;t
          yet list <code className="font-mono">gmail.settings.basic</code>.
          A project admin needs to add it (see &ldquo;Enable alias
          auto-discovery&rdquo; below). As a workaround you can{" "}
          <a
            href="/api/auth/google/start?minimal=1"
            className="underline font-medium"
          >
            reconnect with the core scopes only
          </a>{" "}
          — drafts will work but the alias picker stays empty.
        </div>
      </div>
    );
  }
  if (row.error) {
    return (
      <p className="text-[11px] text-red-700 dark:text-red-300 pl-2 border-l-2 border-red-300">
        Couldn&rsquo;t fetch aliases: {row.error}
      </p>
    );
  }
  const aliases = row.aliases ?? [];
  // The user's own primary address always appears in the sendAs list —
  // filter it out for display so the chip row reads as "extra senders
  // available", not "you can send as yourself".
  const extra = aliases.filter((a) => !a.is_primary);
  if (extra.length === 0) {
    return (
      <p className="text-[11px] text-muted pl-2 border-l-2 border-border italic">
        No send-as aliases configured beyond the primary address. Add
        one via Gmail → Settings → Accounts and Import → Send mail as.
      </p>
    );
  }
  return (
    <div className="pl-2 border-l-2 border-emerald-300">
      <p className="text-[11px] text-muted mb-1">
        {extra.length} alias{extra.length === 1 ? "" : "es"}:
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {extra.map((a) => (
          <li
            key={a.email}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-emerald-300 bg-emerald-50 dark:bg-emerald-500/10 text-[11px] font-mono text-emerald-900 dark:text-emerald-200"
            title={a.name ?? undefined}
          >
            {a.email}
            {a.is_default ? (
              <span
                className="text-[9px] uppercase tracking-wide font-semibold opacity-70"
                title="Gmail's default From address for this account"
              >
                default
              </span>
            ) : null}
          </li>
        ))}
      </ul>
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
