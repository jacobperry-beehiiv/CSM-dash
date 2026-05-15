"use client";

import { useEffect, useState } from "react";
import { fmtDate } from "./format";
import type { ApiToken } from "@/lib/auth/api-tokens";

type StoredToken = Omit<ApiToken, "hash">;

/**
 * Inline UI for the signed-in CSM's API tokens. Generate, copy
 * (once), revoke. List view never reveals the plaintext — only the
 * leading prefix so a CSM can disambiguate "MacBook" from "Linux
 * box" without seeing the secret.
 */
export function ApiTokensEditor() {
  const [tokens, setTokens] = useState<StoredToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [creating, setCreating] = useState(false);
  /** Plaintext returned by the last successful create — shown ONCE so
   *  the user can copy. Reset when the user dismisses the banner or
   *  reloads. */
  const [revealed, setRevealed] = useState<{
    label: string;
    plaintext: string;
  } | null>(null);
  const [copyHit, setCopyHit] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/api-tokens")
      .then(async (r) => {
        if (!r.ok) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<{ tokens: StoredToken[] }>;
      })
      .then(({ tokens }) => {
        if (!cancelled) setTokens(tokens);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unknown");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function createNew() {
    const label = draftLabel.trim();
    if (!label) {
      setError("Pick a label so future-you remembers what this token's for.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const r = await fetch("/api/settings/api-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      const j = (await r.json()) as
        | { token: StoredToken; plaintext: string }
        | { error: string };
      if (!r.ok || !("plaintext" in j)) {
        throw new Error("error" in j ? j.error : `HTTP ${r.status}`);
      }
      setRevealed({ label: j.token.label, plaintext: j.plaintext });
      setTokens((prev) => [j.token, ...prev]);
      setDraftLabel("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create token");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string, label: string) {
    if (
      !window.confirm(
        `Revoke token "${label}"? Any integration using this token will start failing with 401 until it's replaced.`
      )
    ) {
      return;
    }
    try {
      const r = await fetch(`/api/settings/api-tokens/${id}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      setTokens((prev) => prev.filter((t) => t.id !== id));
      if (revealed && tokens.find((t) => t.id === id)?.label === revealed.label) {
        setRevealed(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke");
    }
  }

  async function copyRevealed() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.plaintext);
      setCopyHit(true);
      setTimeout(() => setCopyHit(false), 1500);
    } catch {
      /* clipboard blocked — banner still shows the value */
    }
  }

  return (
    <div className="space-y-4">
      {error ? (
        <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-md p-3 text-sm text-red-800 dark:text-red-300">
          {error}
        </div>
      ) : null}

      {revealed ? (
        <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-md p-3 space-y-2">
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            Copy this token now — we can&apos;t show it again.
          </p>
          <p className="text-xs text-amber-900 dark:text-amber-200">
            Label: <strong>{revealed.label}</strong>. Paste it into the
            integration that needs it (Claude skill config, .env.local,
            etc.). Once you navigate away from this page, the plaintext
            is gone for good — but you can always revoke it and mint a
            new one.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-xs bg-surface-2 border border-border rounded px-2 py-1.5 break-all">
              {revealed.plaintext}
            </code>
            <button
              onClick={copyRevealed}
              className="px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover whitespace-nowrap"
            >
              {copyHit ? "Copied ✓" : "Copy"}
            </button>
            <button
              onClick={() => setRevealed(null)}
              className="px-2 py-1.5 border border-border-strong rounded-md text-sm hover:bg-canvas"
              title="Dismiss this banner. Make sure you've already copied the token."
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      <section className="bg-surface rounded-xl border border-border shadow-card p-4 space-y-3">
        <h2 className="text-sm font-semibold text-fg">Generate a new token</h2>
        <p className="text-xs text-muted">
          Give each integration its own token so it&apos;s easy to revoke
          one without breaking the others.
        </p>
        <div className="flex flex-wrap items-stretch gap-2">
          <input
            type="text"
            value={draftLabel}
            onChange={(e) => setDraftLabel(e.target.value)}
            placeholder="Label (e.g. Claude skill — MacBook)"
            maxLength={80}
            className="flex-1 min-w-[240px] px-3 py-2 border border-border-strong rounded-md text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter") createNew();
            }}
          />
          <button
            onClick={createNew}
            disabled={creating || !draftLabel.trim()}
            className="px-3 py-2 bg-accent text-accent-fg rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
          >
            {creating ? "Generating…" : "+ Generate token"}
          </button>
        </div>
      </section>

      <section className="bg-surface rounded-xl border border-border shadow-card p-4 space-y-3">
        <h2 className="text-sm font-semibold text-fg">Your tokens</h2>
        {loading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="text-sm text-subtle italic">
            No tokens yet. Generate one above to authenticate the Claude
            skill (or any future integration) as you.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted">
              <tr className="text-left border-b border-border">
                <th className="px-2 py-1.5 font-medium">Label</th>
                <th className="px-2 py-1.5 font-medium">Prefix</th>
                <th className="px-2 py-1.5 font-medium">Created</th>
                <th className="px-2 py-1.5 font-medium">Last used</th>
                <th className="px-2 py-1.5 w-16"></th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id} className="border-b border-border align-middle">
                  <td className="px-2 py-2 text-fg">{t.label}</td>
                  <td className="px-2 py-2 font-mono text-xs text-muted">
                    {t.prefix}…
                  </td>
                  <td className="px-2 py-2 text-xs text-muted">
                    {fmtDate(t.created_at)}
                  </td>
                  <td className="px-2 py-2 text-xs text-muted">
                    {t.last_used_at ? (
                      fmtDate(t.last_used_at)
                    ) : (
                      <span className="text-subtle italic">never</span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button
                      onClick={() => revoke(t.id, t.label)}
                      className="px-2 py-1 text-xs border border-red-300 text-red-700 rounded-md hover:bg-red-50 dark:bg-red-500/10"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="bg-surface rounded-xl border border-border shadow-card p-4 space-y-2 text-xs text-muted">
        <h3 className="text-sm font-semibold text-fg">How to use a token</h3>
        <p>
          Pass it as a Bearer header on any request to{" "}
          <code className="font-mono bg-surface-2 px-1 rounded">
            /api/customer-signals
          </code>
          :
        </p>
        <pre className="bg-surface-2 border border-border rounded px-2 py-1.5 overflow-x-auto font-mono text-xs">
          {`Authorization: Bearer csm_dash_…`}
        </pre>
        <p>
          Signals posted with your token are attributed to your email
          automatically (no need to set{" "}
          <code className="font-mono bg-surface-2 px-1 rounded">
            created_by
          </code>{" "}
          in the body unless you want a different value).
        </p>
      </section>
    </div>
  );
}
