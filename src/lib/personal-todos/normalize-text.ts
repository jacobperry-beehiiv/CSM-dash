/**
 * Normalize Slack-mrkdwn artifacts in todo text so the personal
 * to-do list renders readably.
 *
 * Slack messages embed user/channel/group/url references in a
 * bracket-pipe syntax that's noise outside Slack's renderer:
 *
 *   <@U12345>            → user mention, no display name
 *   <@U12345|jacob>      → user mention with name
 *   <!subteam^S123|eng>  → group mention with name
 *   <!subteam^S123>      → group mention, no name
 *   <!here>              → @here / @channel / @everyone
 *   <#C12345|general>    → channel reference
 *   <#C12345>            → channel reference, no name
 *   <https://x.com|read> → link with label
 *   <https://x.com>      → bare link
 *   <mailto:a@b.com|a@b.com> → email
 *
 * Plus Slack's HTML entity encoding (`&lt;`, `&gt;`, `&amp;`) when a
 * message contains literal `<` / `>` / `&`.
 *
 * Used by:
 *   - Slack inbound (DM-to-todo, reaction-to-todo) so the todo title
 *     reads naturally instead of "<@U12345> can you check
 *     <https://foo.com|this>".
 *   - Personal-todos client composer on submit, so when a CSM pastes
 *     Slack-copied text the same cleanup applies.
 *
 * Intentionally lossy: user IDs without a display-name fallback are
 * dropped (we can't resolve them from a static helper). The result
 * may have double-spaces from drops; we collapse those at the end.
 */

const USER_MENTION_RE = /<@U[A-Z0-9]+(?:\|([^>]+))?>/g;
const GROUP_MENTION_RE = /<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g;
const SPECIAL_MENTION_RE = /<!(here|channel|everyone)>/g;
const CHANNEL_REF_RE = /<#[A-Z0-9]+(?:\|([^>]+))?>/g;
// URL pattern matches http://, https://, and mailto: schemes. Slack
// renders all three in the same bracket-pipe syntax.
const LINK_RE = /<((?:https?:\/\/|mailto:)[^|>]+)(?:\|([^>]+))?>/g;

export function normalizeSlackText(input: string): string {
  if (!input) return input;
  let s = input;

  // Decode Slack's HTML-entity escapes first so the bracket-pipe
  // matchers below see literal `<` / `>` characters.
  s = s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

  // User mentions: drop entirely if no name, keep "@name" if we have
  // one. Dropping the bare-ID form is a deliberate tradeoff —
  // resolving U12345 → display name needs a Slack API call we don't
  // want to make per todo.
  s = s.replace(USER_MENTION_RE, (_full, name?: string) =>
    name ? `@${name}` : ""
  );

  // Group/subteam mentions: same shape as user mentions. Keep "@team"
  // when name is present so it's still semantically attributable.
  s = s.replace(GROUP_MENTION_RE, (_full, name?: string) =>
    name ? `@${name}` : ""
  );

  // @here / @channel / @everyone — these are noise once a message
  // leaves its channel. Drop them.
  s = s.replace(SPECIAL_MENTION_RE, "");

  // Channel refs: keep "#name" when name is present, drop otherwise.
  s = s.replace(CHANNEL_REF_RE, (_full, name?: string) =>
    name ? `#${name}` : ""
  );

  // Links: prefer the human label when present, but keep the URL too
  // so the todo is still actionable. Format: "label (url)". For
  // mailto: schemes, strip the prefix from the display since
  // "foo@bar.com" reads cleaner than "mailto:foo@bar.com".
  s = s.replace(LINK_RE, (_full, url: string, label?: string) => {
    const cleanUrl = url.startsWith("mailto:") ? url.slice(7) : url;
    if (!label) return cleanUrl;
    // If the label is literally the URL (common — Slack auto-labels
    // bare URLs that way), just emit the URL once.
    if (label === url || label === cleanUrl) return cleanUrl;
    return `${label} (${cleanUrl})`;
  });

  // Collapse the double-spaces left by mention drops, and trim ends.
  s = s.replace(/[ \t]{2,}/g, " ").replace(/\s+\n/g, "\n").trim();

  return s;
}
