/**
 * The one rule for where a caller-supplied `redirect` may send somebody: a path
 * on this origin, or the dashboard root.
 *
 * A prefix check is not that rule. Browsers read `/\host` as `//host`, and the
 * URL parser drops tabs and newlines anywhere, so `/\evil.example` or
 * `/<TAB>/evil.example` both start with a single slash and still land on another
 * site. So the value is resolved the way a browser resolves it, against a
 * placeholder origin, and kept only when it stayed there. What comes back is the
 * resolved path, never the raw input, so what is checked is what is followed.
 *
 * Pure, so the server (a page turning a signed-in visitor around, an OAuth
 * callback) and the browser share one implementation.
 */

const PLACEHOLDER_ORIGIN = "http://polaris.invalid";

export function safeRedirect(target: string | null | undefined): string {
    if (!target || !target.startsWith("/")) return "/";
    let resolved: URL;
    try {
        resolved = new URL(target, PLACEHOLDER_ORIGIN);
    } catch {
        return "/";
    }
    if (resolved.origin !== PLACEHOLDER_ORIGIN) return "/";
    if (/^[\\/]{2}/.test(resolved.pathname)) return "/";
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

/**
 * The sign-in screen, set to bring the reader back to `back` once they are in.
 * A public link that asks for an account (a drop point for named people, a form
 * for members) sent them to the sign-in screen and then to the dashboard, so
 * they had to find the link again to do what they came for.
 */
export function signInHref(back: string): string {
    return `/oauth/login?redirect=${encodeURIComponent(safeRedirect(back))}`;
}

/**
 * The same rule for a target that is optional: the resolved path when the value
 * stays on this origin, and nothing when it is absent or would leave it, rather
 * than falling back to the root.
 */
export function strictSafeRedirect(target: string | null | undefined): string | null {
    if (!target) return null;
    const resolved = safeRedirect(target);
    return resolved === "/" && target !== "/" ? null : resolved;
}
