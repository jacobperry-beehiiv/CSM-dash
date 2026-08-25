# ADR-0006: Sign-in and Gmail drafting are two separate OAuth flows

**Status:** Accepted · **Baked into:** `src/auth.ts`,
`src/app/api/auth/google/*`, `src/lib/data/gmail-token.ts`,
`src/lib/data/active-user.ts`

## Context

The app needs to (1) authenticate `@beehiiv.com` users and (2) create
Gmail drafts in a CSM's own mailbox. Gmail draft creation needs heavy
scopes (`gmail.compose`, `gmail.modify`, `drive.file`, …). Requesting all
of that at sign-in would put a scary consent screen in front of everyone,
including people who never draft email.

## Decision

Two independent Google OAuth flows:

1. **Sign-in** — NextAuth v5, minimal scope `openid email profile`,
   gated to `@beehiiv.com`. Everyone does this once.
2. **Per-CSM Gmail** — a separate flow at `/api/auth/google/*`,
   requesting the heavy scopes, **opted into later** at `/settings/gmail`
   by CSMs who actually draft. Tokens are stored per-email in KV
   (`gmail-tokens`); the active mailbox is tracked by an HttpOnly
   `csm_active_email` cookie, **not** the NextAuth session.

## Why

- **Least privilege / soft landing.** "Sign in once, opt into drafting
  later" — most viewers never see the Gmail consent screen.
- **`gmail.compose`, never `gmail.send`.** The app creates *drafts*; it
  never sends on a user's behalf. This is a deliberate, auditable
  boundary.
- **Multi-account.** The token store is keyed by email so one browser
  can hold several connected mailboxes; the active-email cookie routes
  draft creation to the right one.

## Consequences

- Bulk-draft API calls resolve the mailbox from the **cookie**, not the
  session — a subtle but important distinction when debugging "drafts
  landed in the wrong account."
- The Gmail `from` alias must be a verified send-as or `drafts.create`
  400s; the API route retries once without the alias
  ([how-to](../how-to/adding-a-draft-cc-option.md)).
- **`DEMO_MODE` doesn't stub auth** — you still sign in (and can still
  connect Gmail) normally in demo.
- **No global auth middleware exists** despite `auth.ts`'s docstring;
  page-level layouts enforce access (`/admin/*` redirects non-admins,
  other pages render with an empty book for anon viewers).
