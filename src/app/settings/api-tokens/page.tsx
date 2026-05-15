import { ApiTokensEditor } from "@/components/api-tokens-editor";

export const dynamic = "force-dynamic";

/**
 * Settings → API tokens. Per-user Bearer-token management for the
 * customer-signals endpoint. Each CSM mints their own so signals are
 * attributed to them automatically; revoke without affecting anyone
 * else's integrations.
 */
export default function ApiTokensSettingsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-fg tracking-tight">
          API tokens
        </h2>
        <p className="text-sm text-muted mt-1">
          Personal Bearer tokens for posting customer signals (and
          future integrations) on your behalf. Signals authenticated
          with your token are attributed to your email automatically.
        </p>
      </div>
      <ApiTokensEditor />
    </div>
  );
}
