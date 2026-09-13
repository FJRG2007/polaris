/**
 * When an open vault locks itself again.
 *
 * The worker holds the key in memory and nowhere else, so under manifest v3 it is
 * dropped whenever the browser recycles the service worker - which is a lock that
 * happens on its own, and often within a minute. Firefox is the case that needs
 * this file: a manifest v2 background page is persistent, so nothing recycles it
 * and an unlocked vault would stay unlocked until the browser closed.
 *
 * So the deadline is explicit rather than inherited from the platform, and the two
 * targets behave the same. The decision is here, pure, because it is the kind of
 * arithmetic that is easy to get wrong by an order of magnitude and impossible to
 * see once it is spread across a worker, an alarm and a dropdown.
 */

const MINUTE = 60_000;

/**
 * The stored form of "as long as the browser is open".
 *
 * Zero rather than null, so the setting is one number: a nullable field cannot
 * tell "nobody has chosen yet" from "chosen: until the browser closes", and the
 * two want different answers - the first takes the default below, the second is
 * somebody's decision and must survive being read back.
 */
export const UNTIL_BROWSER_CLOSES = 0;

/** How long an unlocked vault may sit unused before it locks itself. */
export interface TimeoutChoice {
    readonly label: string;
    /** Milliseconds of disuse, or `UNTIL_BROWSER_CLOSES`. */
    readonly ms: number;
}

/**
 * What the popup offers, longest-lived last.
 *
 * There is no "never": every choice here is bounded by the browser session,
 * because the alternative is keeping the key somewhere a restart cannot take it,
 * and key material at rest is the one thing this extension is built to avoid.
 */
export const TIMEOUT_CHOICES: readonly TimeoutChoice[] = [
    { label: "1 minute", ms: MINUTE },
    { label: "5 minutes", ms: 5 * MINUTE },
    { label: "15 minutes", ms: 15 * MINUTE },
    { label: "30 minutes", ms: 30 * MINUTE },
    { label: "1 hour", ms: 60 * MINUTE },
    { label: "4 hours", ms: 240 * MINUTE },
    { label: "When the browser closes", ms: UNTIL_BROWSER_CLOSES }
];

/**
 * The deadline somebody gets without choosing one.
 *
 * Short enough that a shared or forgotten screen is not an open vault for the rest
 * of the day, long enough that a normal hour of work is not a series of master
 * password prompts. Somebody who wants either extreme is offered it above.
 */
export const DEFAULT_TIMEOUT_MS = 15 * MINUTE;

/**
 * The timeout as stored, or the default when it is anything else.
 *
 * Storage is an external input like any other: it survives updates, it can be
 * edited by hand in a browser profile, and a value this file does not offer must
 * not become a deadline. Anything unrecognised - a string, a negative number, an
 * hour nobody was offered - reads as unset, which is the safe direction because
 * the default is one of the shorter choices rather than the longest.
 */
export function readTimeout(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
    return TIMEOUT_CHOICES.some((choice) => choice.ms === value) ? value : DEFAULT_TIMEOUT_MS;
}

/**
 * When a vault used at `now` should lock, or null if only the browser closing does.
 *
 * Called on every use rather than once at unlock, so the deadline is one of disuse:
 * somebody working in the vault keeps pushing it forward and is never interrupted,
 * and somebody who walked away stops pushing it.
 */
export function deadlineFrom(now: number, timeout: number): number | null {
    const ms = readTimeout(timeout);
    return ms === UNTIL_BROWSER_CLOSES ? null : now + ms;
}

/**
 * Whether a deadline has been reached.
 *
 * Inclusive, and null is never expired. A clock that jumped backwards - a laptop
 * waking with a corrected time, a timezone change - only ever delays this, which
 * is why the alarm that calls it runs on a period rather than being scheduled once
 * for the deadline itself.
 */
export function hasExpired(now: number, until: number | null): boolean {
    return until !== null && now >= until;
}
