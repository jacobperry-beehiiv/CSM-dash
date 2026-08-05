# How to: add a template merge tag

Merge tags are the `{{customer.name}}`-style tokens CSMs drop into
outreach templates; they resolve against a `Customer` (plus optional
context) at draft time. This is a **two-edit change**, both in one file:
`src/lib/templates/merge-tags.ts`.

## How the system works

- `MERGE_TAGS: MergeTag[]` (`merge-tags.ts:264-635`) is the registry.
  Each entry is `{ token, label, description, resolve(c, ctx) }`.
- It's indexed into `TAG_INDEX` (`:637`) for O(1) lookup — rebuilt from
  the array, so adding an entry is all it takes to register a tag.
- `applyMergeTags(template, customer, ctx)` (`:659-697`) runs two passes:
  1. **Conditional blocks** `{{#token}}…{{/token}}` — inner content
     renders only if the token resolves to a non-empty string.
  2. **Plain substitution** `{{token}}` — unknown tokens are left
     **literal** (so a typo is visible in preview, not silently blank).
- `MergeContext` (`:18-89`) carries optional extra inputs beyond the
  `Customer`: `ladder` (tier), `adGap`, `recipient_email`/`recipient_count`,
  Past Due `MONTH`/`REASON`, and a nested `deliverability` object.

## Steps

### 1. (Only if you need data beyond the `Customer`) extend `MergeContext`

If your tag resolves purely from `Customer` fields, **skip this**.

Otherwise add an optional field to `MergeContext` (`:18-89`) and thread
it through the callers that build `ctx`:
- `src/components/outreach-modal.tsx` (~`:200-205`)
- `src/lib/templates/bulk-drafts.ts` (`ctx` at ~`:153`)
- `src/lib/links.ts` compose-URL builders (~`:202`, `:229`)

### 2. Add the registry entry

Add to `MERGE_TAGS` (`:264-635`):

```ts
{
  token: "customer.my_tag",        // typed as {{customer.my_tag}}
  label: "Human label",            // shown in the template editor's tag menu
  description: "One-line explanation for the picker.",
  resolve: (c, ctx) => fmtWhatever(c.my_field) ?? "—",
},
```

**Return-value convention — get this right:**

| Situation | Return | Why |
|---|---|---|
| Value missing but the tag should be *visible* | `"—"` | Customer/tier/adGap convention — reads as "no data" |
| Tag is meant to be wrapped in `{{#token}}…{{/token}}` conditional copy | `""` | Empty lets the surrounding prose hide entirely (deliverability convention) |

**Reuse the in-file formatters** instead of rolling your own:
`fmtCurrency` (`:98`), `fmtNumber` (`:107`), `fmtDate` (`:112`),
`pct` (`:219`), `firstNameForContext` (`:194`). For tier tags, wrap the
resolver with `tierResolver(...)` (`:229`) so a missing `ctx.ladder`
degrades to `"—"`.

That's it — no other file changes. `TAG_INDEX` rebuilds from the array
and every draft surface (template editor preview, bulk drafts, single
outreach modal) picks it up.

## Gotchas

- **First-name resolution is deliberately cautious.**
  `firstNameForContext` (`:194-217`) returns `"there"` for group sends
  (`recipient_count > 1`) and when it can't confidently identify one
  recipient — it will *not* guess a wrong contact's name (the
  speedtoscale.com bug). `firstName()` bails to `"there"` for anything
  containing `@`. If you add a name-ish tag, follow the same posture.
- **Unknown tokens stay literal**, so a mistyped `token` in your entry
  won't error — it just won't resolve. Verify the exact token string in
  the editor preview.

## Verify

```bash
npx tsc --noEmit
```

Then open `/settings/templates`, edit a template, insert your tag from
the merge-tag menu (or type `{{customer.my_tag}}`), and check the live
**Preview** pane on the right renders the expected value against the
example customer.
