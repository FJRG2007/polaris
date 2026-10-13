/**
 * A Last.fm username, as somebody types it to have their music shown here.
 *
 * Last.fm publishes no rule for what a username may contain, so this is a bound
 * rather than Last.fm's own check: the characters its profile addresses are made
 * of, and a length no real one comes near. Whether the name exists is asked of
 * Last.fm itself when it is saved. Names are looked up without regard to case,
 * so two spellings of one name are the same name (`sameLastfmName`).
 */

import { z } from "zod";

export const LASTFM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

export const lastfmNameSchema = z
    .string()
    .trim()
    .min(1, "connections.errors.typeLastfmName")
    .regex(LASTFM_NAME_PATTERN, "connections.errors.lastfmNameShape");

/** Whether two typed names are the same Last.fm account. */
export function sameLastfmName(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}
