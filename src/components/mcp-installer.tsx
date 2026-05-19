"use client";

import { useEffect, useMemo, useState } from "react";
import type { ApiToken } from "@/lib/auth/api-tokens";

type StoredToken = Omit<ApiToken, "hash">;

/**
 * Live installer for the dashboard's MCP server. Lists the signed-in
 * CSM's existing API tokens, lets them pick one to embed, and shows
 * a copy-ready config snippet for either Claude Desktop or Claude
 * Code. The snippet uses the token PREFIX as a placeholder — the
 * teammate has to paste their actual token in by hand, since we
 * can't recover plaintext after creation.
 */

type Client = "claude-code" | "claude-desktop";

const ORIGIN_FALLBACK = "https://csm-dash.vercel.app";

export function McpInstaller() {
  const [tokens, setTokens] = useState<StoredToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<Client>("claude-code");
  const [copied, setCopied] = useState(false);

  // Resolve the public origin so the snippet has the right URL even
  // when this is rendered on a preview deployment. window.location
  // is only available client-side; fall back to the prod origin.
  const origin = useMemo(() => {
    if (typeof window === "undefined") return ORIGIN_FALLBACK;
    return window.location.origin;
  }, []);
  const url = `${origin}/api/mcp`;

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

  const snippet = useMemo(() => {
    // Use the most-recent token's prefix in the placeholder so the
    // teammate can see "csm_dash_3f8a…" and recognise which token
    // they're embedding. If they have no tokens we still render the
    // snippet so they know what it'll look like.
    const placeholder = tokens[0]?.prefix
      ? `${tokens[0].prefix}<paste the rest of your token here>`
      : "csm_dash_<your token from /settings/api-tokens>";
    if (client === "claude-code") {
      return JSON.stringify(
        {
          mcpServers: {
            "csm-dash": {
              type: "http",
              url,
              headers: {
                Authorization: `Bearer ${placeholder}`,
              },
            },
          },
        },
        null,
        2
      );
    }
    // Claude Desktop uses the same shape under "mcpServers" but lives
    // in a different config file. Visually identical to the user.
    return JSON.stringify(
      {
        mcpServers: {
          "csm-dash": {
            type: "http",
            url,
            headers: {
              Authorization: `Bearer ${placeholder}`,
            },
          },
        },
      },
      null,
      2
    );
  }, [client, tokens, url]);

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — fall back to manual copy */
    }
  }

  return (
    <div className="space-y-4">
      {error ? (
        <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-md p-3 text-sm text-red-800 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <section className="bg-surface rounded-xl border border-border shadow-card p-4 space-y-3">
        <h2 className="text-sm font-semibold text-fg">1. Get a token</h2>
        {loading ? (
          <p className="text-sm text-muted">Loading tokens…</p>
        ) : tokens.length === 0 ? (
          <p className="text-sm text-muted">
            You don&apos;t have any API tokens yet — head to{" "}
            <a
              href="/settings/api-tokens"
              className="text-accent hover:underline"
            >
              /settings/api-tokens
            </a>{" "}
            and mint one labelled &ldquo;Claude MCP&rdquo; or similar.
            Tokens are revealed once at creation — copy it before
            navigating away.
          </p>
        ) : (
          <p className="text-sm text-muted">
            You have {tokens.length} token{tokens.length === 1 ? "" : "s"}
            . Pick the one you want to embed (mint another at{" "}
            <a
              href="/settings/api-tokens"
              className="text-accent hover:underline"
            >
              /settings/api-tokens
            </a>{" "}
            if you&apos;d like a dedicated MCP token). The snippet below
            shows its prefix as a placeholder — paste the full token in
            place of <code className="font-mono bg-surface-2 px-1 rounded">{`<paste…>`}</code>.
          </p>
        )}
      </section>

      <section className="bg-surface rounded-xl border border-border shadow-card p-4 space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-fg">2. Add the config</h2>
          <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
            {(
              [
                { value: "claude-code", label: "Claude Code" },
                { value: "claude-desktop", label: "Claude Desktop" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.value}
                onClick={() => setClient(opt.value)}
                className={`px-2.5 py-1 ${
                  client === opt.value
                    ? "bg-accent text-accent-fg font-medium"
                    : "bg-surface text-muted hover:text-fg"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <p className="text-xs text-muted">
          {client === "claude-code" ? (
            <>
              Paste this into{" "}
              <code className="font-mono bg-surface-2 px-1 rounded">
                ~/.claude.json
              </code>{" "}
              (merge with any existing{" "}
              <code className="font-mono bg-surface-2 px-1 rounded">
                mcpServers
              </code>{" "}
              block), then restart Claude Code. Tools appear as{" "}
              <code className="font-mono bg-surface-2 px-1 rounded">
                csm-dash:&lt;tool&gt;
              </code>
              .
            </>
          ) : (
            <>
              Paste this into Claude Desktop&rsquo;s{" "}
              <code className="font-mono bg-surface-2 px-1 rounded">
                claude_desktop_config.json
              </code>{" "}
              (Settings → Developer → &ldquo;Edit Config&rdquo;) and
              restart the app. The 9 tools surface in the &ldquo;Search
              and tools&rdquo; menu.
            </>
          )}
        </p>

        <div className="relative">
          <pre className="bg-surface-2 border border-border rounded-md p-3 overflow-x-auto text-xs font-mono whitespace-pre">
            {snippet}
          </pre>
          <button
            onClick={copySnippet}
            className="absolute top-2 right-2 px-2 py-1 text-xs bg-surface border border-border-strong rounded hover:bg-canvas"
          >
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>
      </section>

      <section className="bg-surface rounded-xl border border-border shadow-card p-4 space-y-2 text-xs text-muted">
        <h3 className="text-sm font-semibold text-fg">3. Tools available</h3>
        <p>
          Once the MCP is installed and Claude has reconnected, ask
          things like:
        </p>
        <ul className="list-disc pl-5 space-y-0.5">
          <li>
            <em>&ldquo;Find Morning Brew in the customer book and show me their last signals.&rdquo;</em>
          </li>
          <li>
            <em>&ldquo;Who&rsquo;s in my at-risk list this week?&rdquo;</em>
          </li>
          <li>
            <em>&ldquo;Log a touchpoint for workspace XYZ: had a call about Q3 expansion.&rdquo;</em>
          </li>
          <li>
            <em>&ldquo;Add a team-task: review past-due Slack template by Friday.&rdquo;</em>
          </li>
        </ul>
        <p className="pt-2">
          Full tool list:{" "}
          <code className="font-mono bg-surface-2 px-1 rounded">customer.search</code>,{" "}
          <code className="font-mono bg-surface-2 px-1 rounded">customer.get</code>,{" "}
          <code className="font-mono bg-surface-2 px-1 rounded">signals.list</code>,{" "}
          <code className="font-mono bg-surface-2 px-1 rounded">at_risk.list</code>,{" "}
          <code className="font-mono bg-surface-2 px-1 rounded">past_due.list</code>,{" "}
          <code className="font-mono bg-surface-2 px-1 rounded">team_tasks.list</code>,{" "}
          <code className="font-mono bg-surface-2 px-1 rounded">signals.post</code>,{" "}
          <code className="font-mono bg-surface-2 px-1 rounded">team_tasks.add</code>,{" "}
          <code className="font-mono bg-surface-2 px-1 rounded">customer.set_cadence</code>
          .
        </p>
        <p>
          Every call is attributed to whichever email owns the API
          token used. Signals you post show up with your email as{" "}
          <code className="font-mono bg-surface-2 px-1 rounded">
            created_by
          </code>
          .
        </p>
      </section>
    </div>
  );
}
