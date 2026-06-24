/**
 * Stylized walking-dog silhouette inspired by the icon the user
 * picked. All paths use `currentColor` so the icon can be themed by
 * the parent (white when riding the celebration sweep, black on a
 * light background, etc.).
 *
 * Drawn with chunky rounded rectangles for body + legs + tail and a
 * head with a triangular ear so the silhouette reads as "dog walking
 * right" at small sizes (the celebration uses it at ~24-32px).
 */
export function DogIcon({
  className,
}: {
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 100 80"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      {/* Tail — angled up-back */}
      <rect
        x="8"
        y="22"
        width="9"
        height="22"
        rx="4"
        transform="rotate(-18 12 33)"
      />
      {/* Body — main barrel */}
      <rect x="18" y="28" width="50" height="22" rx="6" />
      {/* Neck/collar bridge into head */}
      <polygon points="60,30 72,18 78,18 70,32" />
      {/* Head */}
      <rect x="64" y="14" width="26" height="22" rx="4" />
      {/* Ear — pointy, leaning forward */}
      <polygon points="86,8 92,16 84,18" />
      {/* Snout — wedge nudging forward and down */}
      <rect x="84" y="24" width="11" height="11" rx="2" />
      {/* Back legs */}
      <rect x="22" y="46" width="8" height="26" rx="3" />
      <rect x="32" y="46" width="8" height="26" rx="3" />
      {/* Front legs */}
      <rect x="54" y="46" width="8" height="26" rx="3" />
      <rect x="64" y="46" width="8" height="26" rx="3" />
    </svg>
  );
}
