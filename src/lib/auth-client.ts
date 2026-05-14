"use client";

import { useEffect, useState } from "react";

interface SessionShape {
  user?: { email?: string | null; name?: string | null };
}

let cached: SessionShape | null | undefined = undefined;
let pending: Promise<SessionShape | null> | null = null;

/**
 * Fetches the NextAuth session once per browser tab and caches the
 * result. The session is small JSON (a few hundred bytes) so the cost
 * of fetching is negligible — but components scattered across the tree
 * all need the viewer's email for filtering, so a shared cache prevents
 * a stampede of identical /api/auth/session requests.
 */
function ensureSession(): Promise<SessionShape | null> {
  if (cached !== undefined) return Promise.resolve(cached);
  if (pending) return pending;
  pending = fetch("/api/auth/session", { cache: "no-store" })
    .then(async (r) => (r.ok ? ((await r.json()) as SessionShape) : null))
    .catch(() => null)
    .then((s) => {
      cached = s;
      pending = null;
      return s;
    });
  return pending;
}

/**
 * Hook: returns the signed-in viewer's email (lowercased) once the
 * session resolves. Returns null pre-resolution and when no session
 * exists. Use for filtering templates / row actions / draft visibility.
 */
export function useViewerEmail(): string | null {
  const [email, setEmail] = useState<string | null>(() => {
    if (cached === undefined) return null;
    return (cached?.user?.email ?? null) as string | null;
  });

  useEffect(() => {
    if (cached !== undefined) {
      setEmail((cached?.user?.email ?? null)?.toLowerCase() ?? null);
      return;
    }
    let cancelled = false;
    ensureSession().then((s) => {
      if (cancelled) return;
      setEmail((s?.user?.email ?? null)?.toLowerCase() ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return email;
}
