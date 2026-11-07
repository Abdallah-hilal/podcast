/**
 * Build a `/login?next=…` URL that preserves the current page so the user
 * lands back where they tried to go after signing in. Safe in SSR contexts:
 * returns a plain `/login` when `window` isn't available.
 */
export function loginUrlWithNext(): string {
  if (typeof window === "undefined") return "/login";
  const next = window.location.pathname + window.location.search;
  if (next === "/" || next === "/login" || next === "/signup") return "/login";
  return `/login?next=${encodeURIComponent(next)}`;
}
