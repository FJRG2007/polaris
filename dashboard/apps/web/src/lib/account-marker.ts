/**
 * The account this browser was last drawn for, as one localStorage entry.
 *
 * Its own module so what is kept per account (`last-place`) can read it without
 * importing the account switch, which imports them back to clear them.
 */

export const ACCOUNT_MARKER_KEY = "polaris.account.current";

/** The account the page was drawn for, or null before one has been. */
export function currentAccount(): string | null {
    try {
        return window.localStorage.getItem(ACCOUNT_MARKER_KEY) || null;
    } catch {
        return null;
    }
}
