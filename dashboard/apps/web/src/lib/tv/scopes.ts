/**
 * What Polaris TV is allowed. Nothing a permission names: a TV's key carries no
 * scope, so it opens no API but `/api/tv`, which answers only with its owner's
 * own name and counts. A set in a living room is a poor place for anything more.
 *
 * Client-safe: the approval screen imports it.
 */

/** How long a TV stays connected before it has to be connected again. */
export const TV_TOKEN_DAYS = 365;

/** Where somebody answers a TV's request, with its code already filled in. */
export function tvApprovePath(userCode: string): string {
    return `/account/tv?code=${encodeURIComponent(userCode)}`;
}
