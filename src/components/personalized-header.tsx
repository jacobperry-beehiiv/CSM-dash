"use client";

import { usePersonalization } from "./personalization-provider";

/**
 * Header brand block that swaps the default beehiiv logo for a custom
 * one when the viewer has personalization saved + Business Mode off,
 * and prepends the custom dashboard name as inline text next to it.
 *
 * The fallback logo is passed in from the server-side layout so the
 * default path stays a server component (no flash, no client bundle
 * cost when personalization is null). This component only mounts on
 * the client to react to Business Mode toggling.
 */
export function PersonalizedHeader({
  fallbackLogo,
}: {
  fallbackLogo: React.ReactNode;
}) {
  const p = usePersonalization();
  const name = p?.dashboard_name?.trim() || null;
  const logo = p?.logo_url?.trim() || null;
  return (
    <>
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logo}
          alt="Dashboard logo"
          className="h-7 w-7 object-contain rounded"
        />
      ) : (
        fallbackLogo
      )}
      {name ? (
        <span className="text-fg font-semibold tracking-tight text-[15px] hidden sm:inline">
          {name}
        </span>
      ) : null}
    </>
  );
}
