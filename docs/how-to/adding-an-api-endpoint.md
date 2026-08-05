# How to: add an API endpoint

API routes live at `src/app/api/**/route.ts` (Next.js App Router). There
are ~130 of them and they're highly consistent — copy the pattern rather
than inventing one.

## The canonical skeleton

```ts
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadThing, setThing } from "@/lib/data/thing";
import { appendActionLog } from "@/lib/data/customer-signals";

export const dynamic = "force-dynamic";
// export const maxDuration = 300; // ONLY if the handler calls a slow engine

// GET — usually unauthed, returns the loaded map/list
export async function GET() {
  try {
    return NextResponse.json(await loadThing());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

interface PostBody {
  workspace_id: string;
  value: string;
}

// POST/PATCH/PUT — auth-gated mutation
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.workspace_id) {
    return NextResponse.json(
      { error: "workspace_id is required" },
      { status: 400 }
    );
  }
  try {
    const map = await setThing(body, {
      setBy: session.user.email.toLowerCase(),
    });
    await appendActionLog([
      { workspace_id: body.workspace_id, text: "…", action_kind: "thing_set" },
    ]);
    return NextResponse.json(map);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
```

## The rules (why each line is there)

- **`export const dynamic = "force-dynamic"`** — present in ~93 of the
  route files. Without it, Next may static-cache a data route and serve
  stale results. Near-universal; include it.
- **`export const maxDuration = 300`** — only for handlers that call a
  heavy engine or external API, or they hit the platform default timeout.
- **GET vs mutation split** — `GET` is typically **unauthed** and just
  returns a KV/data map (the dashboard reads these freely). Mutations
  auth-gate, validate, mutate, then audit.
- **Auth gate** — the exact idiom, repeated verbatim across the repo:
  ```ts
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  ```
  The lower-cased email is the canonical user key and goes onto audit
  entries.
- **Error handling** — wrap the body in try/catch and return
  `{ error: e instanceof Error ? e.message : "Unknown error" }` with
  status 500. This exact shape is everywhere.
- **Body validation** — parse in a try/catch → `{ error: "Invalid JSON" }`
  400; validate required fields with specific messages; validate enums
  against a `Set` built from the canonical constant array (see
  `review-states` for the pattern).
- **Audit** — mutations should `await appendActionLog([...])`. It's the
  house convention and `appendActionLog` **never throws**, so you don't
  need to guard it.

## Variations

### Feature-flag gating

For features shipping dark, gate with the admin flag AND the feature's
own eligibility check at the same point:

```ts
import { isFeatureEnabledFor } from "@/lib/auth/feature-flags";

if (!(await isFeatureEnabledFor("my-feature", email))) {
  return NextResponse.json({ error: "Not available" }, { status: 403 });
}
```

`isFeatureEnabledFor` soft-fails to `false` (under-grant over over-grant)
and can only *narrow* access — it never grants beyond the feature's own
check. To add the flag itself, see
[adding-a-settings-field.md](adding-a-settings-field.md#feature-flags)
and `src/lib/data/admin-flags-types.ts`.

### Cron / sweep routes (dual auth)

Sweeps are hit both by a GitHub Action (bearer `CRON_SECRET`) and by an
admin "Run now" button (session). Use the `authorize(req)` helper pattern
(see `src/app/api/deliverability/sweep/route.ts`): return
`"cron" | "manual" | false` and thread `triggeredBy` into the engine.

```ts
function authorize(req: Request): "cron" | "manual" | false {
  const bearer = req.headers.get("authorization");
  if (bearer === `Bearer ${process.env.CRON_SECRET}`) return "cron";
  // else fall through to session auth in the handler → "manual"
}
```

## Where does the logic go?

Keep route handlers thin. Real work belongs in:
- a **store** under `src/lib/data/` (for KV-backed CRUD — see
  [adding-a-settings-field.md](adding-a-settings-field.md) for the
  store shape), or
- an **engine** under `src/lib/engines/` (for analysis over
  `Customer[]`), so the same logic can run from a CLI/cron too.

## Verify

```bash
npx tsc --noEmit
```

Then exercise it:

```bash
curl -s localhost:3000/api/your-thing | jq        # GET (unauthed)
```

For auth-gated mutations, drive it from the UI while signed in via the
preview bypass (see [CLAUDE.md](../../CLAUDE.md#local-development)) — the
session cookie is what the route reads.
