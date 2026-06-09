/**
 * Shared per-CSM Slack rollup helpers.
 *
 * Lives here (not in slack-bulk-compose.tsx) so server code — the
 * proactive-outreach sweep engine, the past-due history sweep,
 * any future cron — can render the same rollup format the manual
 * panel button uses, without dragging a "use client" component into
 * the server bundle.
 *
 * Token contract is documented on SlackChannel.rollup_template in
 * src/lib/data/settings-types.ts. The hard-coded default below is
 * also the placeholder shown in /settings/slack.
 */

/** Hard-coded fallback template — emitted when no
 *  `settings.slack.channels[].rollup_template` is configured. Same
 *  copy the panel shows as a placeholder, so an unset field
 *  renders identically to leaving the default in. */
export const DEFAULT_ROLLUP_TEMPLATE =
  "Hey {{csm_mention}}, you have *{{count}} {{rollup_noun}}* that need review for {{rollup_context}}.\n\n{{filtered_link}}";

export interface RollupTokens {
  csm_mention: string;
  csm_name: string;
  csm_handle: string;
  count: string;
  rollup_noun: string;
  rollup_context: string;
  filtered_url: string;
  filtered_link: string;
}

/**
 * Resolve a Slack-mrkdwn rollup template against the per-CSM
 * context. Unknown tokens are left as `{{token}}` so a typo in the
 * settings UI shows up in the rendered message rather than getting
 * silently dropped — easier to debug. Tokens are case-sensitive
 * (the underlying regex matches lowercase + underscore).
 */
export function renderRollupTemplate(
  template: string,
  tokens: RollupTokens
): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (full, raw: string) => {
    const key = raw as keyof RollupTokens;
    return Object.prototype.hasOwnProperty.call(tokens, key)
      ? tokens[key]
      : full;
  });
}

/**
 * Build the per-CSM rollup tokens for a given CSM block — handle,
 * Slack ID, count, deep link base. Used by both the client modal's
 * `buildCsmRollupMessages` and the server-side sweep engine so the
 * two surfaces produce byte-identical strings.
 *
 * `deepLinkBase` plus `?csm=<encoded handle>` builds the
 * filtered_url. An unset deep link OR an unassigned CSM (no handle)
 * leaves the link tokens as empty strings — templates that only
 * reference {{filtered_link}} render without the CTA in that case.
 */
export function buildRollupTokens(args: {
  csmHandle: string | null;
  csmSlackId: string | null;
  count: number;
  rollupNoun: string;
  rollupContext: string;
  deepLinkBase?: string | null;
}): RollupTokens {
  const friendlyHandle = args.csmHandle
    ? args.csmHandle.replace(/_/g, " ")
    : "Unassigned";
  const mention = args.csmSlackId
    ? `<@${args.csmSlackId}>`
    : friendlyHandle;
  let link = "";
  if (args.deepLinkBase && args.csmHandle) {
    const sep = args.deepLinkBase.includes("?") ? "&" : "?";
    link = `${args.deepLinkBase}${sep}csm=${encodeURIComponent(args.csmHandle)}`;
  }
  return {
    csm_mention: mention,
    csm_name: friendlyHandle,
    csm_handle: args.csmHandle ?? "",
    count: String(args.count),
    rollup_noun: args.rollupNoun,
    rollup_context: args.rollupContext,
    filtered_url: link,
    filtered_link: link ? `<${link}|Open the filtered list ↗>` : "",
  };
}
