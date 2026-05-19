import { McpInstaller } from "@/components/mcp-installer";

export const dynamic = "force-dynamic";

/**
 * Settings → MCP. Self-serve installer for the dashboard's MCP
 * server. Teammates land here, mint a token at /settings/api-tokens
 * if they don't have one, then copy the config snippet into Claude
 * Code or Claude Desktop.
 */
export default function McpSettingsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-fg tracking-tight">
          MCP server
        </h2>
        <p className="text-sm text-muted mt-1">
          Connect Claude (Code or Desktop) to the dashboard so you can
          read at-risk accounts, look up customers, and post signals
          directly from any Claude session. Authenticates via your
          personal API token.
        </p>
      </div>
      <McpInstaller />
    </div>
  );
}
