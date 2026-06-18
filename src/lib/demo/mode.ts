/**
 * Demo-mode flag. When `DEMO_MODE=true` is set in the environment
 * (typically only in a developer's `.env.local`), every data-loader
 * touchpoint in the app should swap its real backend for a fixture
 * file under src/lib/demo/. Every write path should short-circuit to
 * a no-op success.
 *
 * Intentionally server-only — the flag never reaches the client.
 * Anything client-side that needs to behave differently in demo
 * (currently: nothing) would have to be passed down explicitly as
 * a prop from a server component.
 *
 * The flag is normalized so any truthy-ish value enables demo mode:
 * "true", "1", "yes". Anything else (including unset) leaves real
 * data sources intact. The asymmetry is deliberate — a typo in the
 * env var should leave production behavior alone, not silently
 * enable a fake-data dashboard.
 */

export function isDemoMode(): boolean {
  const raw = process.env.DEMO_MODE;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}
