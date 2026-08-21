/**
 * How long a suspension runs for.
 *
 * A day first, because a suspension is nearly always "come back tomorrow"; the
 * rest are the shapes a moderation decision actually takes, plus the one that
 * does not end. Zero is a ban with no end - the deliberate choice rather than
 * the default, since a ban somebody has to remember to lift a week later is the
 * one every administrator meant to be a suspension.
 *
 * Its own module because two screens offer it - the record for one account, and
 * the menu on a row of the directory - and a second copy would be a second list
 * to keep in step.
 */

export const BAN_LENGTHS = [
    { minutes: 60, label: "For 1 hour" },
    { minutes: 1440, label: "For 1 day" },
    { minutes: 4320, label: "For 3 days" },
    { minutes: 10080, label: "For 1 week" },
    { minutes: 43200, label: "For 30 days" },
    { minutes: 0, label: "Until lifted" }
] as const;

/** What the button says: a length is a suspension, no length is a ban. */
export function banVerb(minutes: number): string {
    return minutes > 0 ? "Suspend" : "Ban";
}
