/**
 * A length of time, as words from the `chat` catalog rather than as English.
 *
 * The same rounding `slowmodeSpoken` and `editWindowLabel` in `@polaris/core`
 * use, returned as a key and a count so it can be said in the reader's language:
 * `t(spoken.key, spoken.params)` on a screen, or as a parameter of a refusal
 * (`ChatText`) that is translated where it is answered. Pure, and free of any
 * catalog, so a client component can use it as well.
 */

import * as core from "@polaris/core";

/** A catalog message and its values. The key is under the `chat` namespace. */
export interface DurationText {
    readonly key: "time.seconds" | "time.minutes" | "time.hours" | "time.days" | "time.always";
    readonly params: { readonly count: number };
}

/** A wait in seconds, rounded to its largest whole unit: "40 seconds", "2 minutes", "1 hour". */
export function spokenWait(seconds: number): DurationText {
    if (seconds >= 3600) return { key: "time.hours", params: { count: Math.round(seconds / 3600) } };
    if (seconds >= 60) return { key: "time.minutes", params: { count: Math.round(seconds / 60) } };
    return { key: "time.seconds", params: { count: seconds } };
}

/** How long a message stays editable, in minutes: "15 minutes", "1 day", "always". */
export function spokenEditWindow(minutes: number): DurationText {
    if (minutes === core.CHAT_NO_LIMIT) return { key: "time.always", params: { count: 0 } };
    if (minutes < 60) return { key: "time.minutes", params: { count: minutes } };
    if (minutes < 60 * 24) return { key: "time.hours", params: { count: Math.round(minutes / 60) } };
    return { key: "time.days", params: { count: Math.round(minutes / (60 * 24)) } };
}
