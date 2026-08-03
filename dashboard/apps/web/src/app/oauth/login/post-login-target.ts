/**
 * Where a finished sign-in lands. Shared by every way in on this screen - the
 * password, a passkey, a scanned code - so they all honour the same handoff.
 *
 * Read from window.location rather than useSearchParams so the callers do not
 * each need a Suspense boundary, and only ever a same-origin relative path: the
 * parameter is the caller's to write, and following it anywhere else would make
 * the sign-in screen an open redirect.
 *
 * With nothing to honour it lands on the dashboard root, which resolves the
 * starting point this account's role actually opens - not every account has
 * Drive, and one that has nothing still has to land somewhere.
 */
export function postLoginTarget(): string {
    const redirect = new URLSearchParams(window.location.search).get("redirect");
    return redirect && redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "/";
}
