# How to: add a per-draft field (CC/BCC/…) to the outreach pipeline

The outreach drafting pipeline runs UI → API → Gmail, and a per-draft
value (like `cc`) has to be threaded through every layer or it gets
dropped silently. This is the map. The worked example is
[PR #149](https://github.com/jacobperry-beehiiv/CSM-dash/pull/149) (the
Richard/Juliet CC toggle) — and CC/BCC already trace this exact path, so
use them as the reference implementation.

## The pipeline

```
buildBulkDrafts()                     src/lib/templates/bulk-drafts.ts
   │  (merge tags applied, recipients + from + compose_url built)
   ▼
<BulkDraftsModal drafts={…}>          src/components/bulk-drafts-modal.tsx
   │  user toggles recipients / labels / From-alias / combine-BCC
   │  actionableDrafts (live re-render) → draftPayloads
   ▼
POST /api/drafts/bulk-create          src/app/api/drafts/bulk-create/route.ts
   │  validates active Gmail, resolves labels, loops
   ▼
createGmailDraftFor()                 src/lib/integrations/gmail-api.ts
   │  buildRfc822() writes headers → base64url → drafts.create
   ▼
Gmail draft in the CSM's Drafts folder
```

The single-account `OutreachModal` (`src/components/outreach-modal.tsx`)
hits the **same** `/api/drafts/bulk-create` endpoint with a one-element
`drafts` array, so wire it there too if the field should appear on
single drafts.

## Threading a new per-draft field end-to-end

If the field is **derived per customer** (like `ccLookup`), edit in this
order:

1. **`src/lib/templates/bulk-drafts.ts`** — add a lookup to
   `BuildBulkDraftsInput` (`:42-85`) and set the field on the emitted
   `BulkDraft` (~`:207-226`).
2. **`src/components/bulk-drafts-modal.tsx`** — add the field to the
   `BulkDraft` interface (`:32-94`) and forward it in the
   `draftPayloads` POST body (~`:697-719`).
3. **`src/app/api/drafts/bulk-create/route.ts`** — accept it on
   `PostBody.drafts[]` (`:17-60`) and pass it to `createGmailDraftFor`.
4. **`src/lib/integrations/gmail-api.ts`** — add it to `DraftInput`
   (`:9-23`) and emit the header in `buildRfc822` (`:33-56`).

If the field is a **UI toggle** (like the team CC — a batch-level choice
the user makes in the modal, applied on top of per-customer values), the
backend already accepts `cc`, so you often only touch the modal:

1. A small config for the options — e.g. `src/lib/data/team-cc.ts`
   exports `TEAM_CC_OPTIONS`.
2. Modal state (`teamCcEmails: Set<string>`) + a checkbox row.
3. A `mergeTeamCc(baseCc)` helper that folds the toggle value into each
   draft's `cc` (de-duped, case-insensitive), applied in
   `actionableDrafts` (so it hits every draft **and** its compose URL)
   and in the combined-BCC draft if it should carry there.

## Gotchas

- **`buildRfc822` only writes `Cc:`/`Bcc:` when non-empty** — pass
  `undefined`, not `""`, for absent values, or you emit a bare header.
- **Alias `from` falls back silently.** If a template sets a `from`
  alias that isn't a verified Gmail send-as, `drafts.create` 400s; the
  API route **retries once without the alias** and increments
  `alias_fallbacks` (surfaced in the toast). The compose-URL ("Open in
  Gmail") path can't fall back — Gmail web has no `from=` param — it just
  opens the right account via `authuser`.
- **Combine-BCC drops per-customer CC on purpose** — folding one
  customer's CSM CC across the whole blast would leak it. A *batch-level*
  team CC is fine to carry there (it's a deliberate global choice); a
  per-customer CC is not. Decide which yours is.
- **Bulk drafts chunk at 40** (`CHUNK_SIZE`) to stay under Vercel's
  ~4.5 MB body cap; the modal aggregates responses across chunks. Your
  field rides along automatically once it's in the payload.
- **Labels need `gmail.modify` scope** and are applied as a separate
  `messages.modify` step (drafts.create silently drops labels) — not
  relevant to header fields, but the same "silent no-op" trap.

## Verify

```bash
npx tsc --noEmit
```

Then in the browser (preview sign-in): open the bulk modal, toggle your
field, and inspect a draft row's **"Open" compose link href** — it
should carry the value (e.g. `&cc=…`). The Gmail-draft-create path reads
the same field, so the compose link is a reliable proxy. Check the
combined-BCC path too if relevant.
