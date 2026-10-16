/**
 * The hostname a tunnel answers on, normalized and checked the same way in the
 * create form and on the server. No imports: the form bundles this.
 */

/** Lowercase, no scheme, no trailing dot or slash. */
export function normalizeHostname(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/[/.]+$/, "");
}

/** A hostname safe to put in a rule. */
export function isRouteHostname(value: string): boolean {
    return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value);
}
