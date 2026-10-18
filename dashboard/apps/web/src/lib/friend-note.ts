/**
 * The note somebody may attach to a friend request.
 *
 * Pure and client-safe, so the field on the friends screen and the action that
 * stores it read one rule. 300 characters is the length a personalized
 * invitation note takes on LinkedIn: enough for "we met at the meetup", short
 * enough that a request stays a request and not a letter.
 */

import { z } from "zod";

export const FRIEND_NOTE_MAX = 300;

/** Trimmed, control characters other than a line break dropped, and runs of
 *  blank lines folded to one. Empty is no note at all. */
export function normalizeFriendNote(raw: unknown): string {
    if (typeof raw !== "string") return "";
    return (
        raw
            .replace(/\r\n?/g, "\n")
            // eslint-disable-next-line no-control-regex
            .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "")
            .replace(/\n{3,}/g, "\n\n")
            .trim()
    );
}

/** What the server accepts: nothing, or a normalized note within the limit. */
export const friendNoteSchema = z
    .unknown()
    .transform(normalizeFriendNote)
    .pipe(z.string().max(FRIEND_NOTE_MAX))
    .transform((note) => (note ? note : null));
