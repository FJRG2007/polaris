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
    return safeRedirect(new URLSearchParams(window.location.search).get("redirect"));
}

/**
 * The same rule, over a value somebody else has already read out.
 *
 * Pure, so the sign-in page can apply it on the server when it turns an
 * already-signed-in visitor around, and so there is one implementation of what
 * counts as a safe destination. A second copy of this is how a sign-in screen
 * becomes an open redirect: the one place it is written is the place it gets
 * audited.
 *
 * A path on this origin, or the dashboard root. `//host` is refused because a
 * browser reads it as a URL on another site, which is the whole attack.
 */
export function safeRedirect(target: string | null | undefined): string {
    return target && target.startsWith("/") && !target.startsWith("//") ? target : "/";
}
