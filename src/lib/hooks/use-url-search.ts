"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

/**
 * Drop-in replacement for `useState<string>("")` that mirrors the value
 * into a URL query param. Lets the user navigate away and back without
 * losing their search filter — also makes the filtered view shareable
 * via URL.
 *
 * Implementation notes:
 *   - Updates use `router.replace`, not `push`, so each keystroke
 *     doesn't pollute browser history.
 *   - Skips `router.refresh()` — search filters every consumer
 *     client-side, so there's no reason to re-render the server tree.
 *   - Local state shadows the URL so input updates feel immediate;
 *     a useEffect resyncs whenever the URL changes from outside the
 *     hook (back/forward button, programmatic nav).
 *
 * Default key is `q` (matches GitHub, Google, etc. URL conventions).
 * Pass a custom key when a single page needs two independent searches.
 */
export function useUrlSearch(
  key: string = "q"
): [string, (next: string) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlValue = searchParams.get(key) ?? "";

  const [local, setLocal] = useState(urlValue);

  // Keep local state in sync when the URL changes from outside the
  // hook (back/forward button, link click, etc.).
  useEffect(() => {
    setLocal(urlValue);
  }, [urlValue]);

  const setValue = useCallback(
    (next: string) => {
      setLocal(next);
      const params = new URLSearchParams(searchParams.toString());
      if (next) params.set(key, next);
      else params.delete(key);
      const qs = params.toString();
      const href = qs ? `${pathname}?${qs}` : pathname;
      router.replace(href, { scroll: false });
    },
    [router, pathname, searchParams, key]
  );

  return [local, setValue];
}
