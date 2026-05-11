"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

interface Props {
  csms: string[];
}

export function CsmSelector({ csms }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = params.get("csm") ?? "";

  function set(value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set("csm", value);
    else next.delete("csm");
    const qs = next.toString();
    const href = qs ? `${pathname}?${qs}` : pathname;
    router.replace(href, { scroll: false });
    router.refresh();
  }

  return (
    <select
      value={current}
      onChange={(e) => set(e.target.value)}
      className="px-2 py-1 border border-border-strong rounded-md text-sm bg-surface"
    >
      <option value="">All CSMs</option>
      {csms.map((c) => (
        <option key={c} value={c}>
          {c.replace(/_/g, " ")}
        </option>
      ))}
    </select>
  );
}
