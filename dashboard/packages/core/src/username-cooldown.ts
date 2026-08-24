/**
 * How often somebody may take a different handle.
 *
 * A username is not a preference, it is an address. It is on somebody's profile,
 * it is what a game server's allow-list was keyed to, it is what another person
 * types to start a conversation, and it is half of how anybody here recognises
 * anybody else. An account free to change it whenever it likes can walk away
 * from all of that on a whim - and can do it often enough that a name nobody saw
 * this morning is already someone else's.
 *
 * The other half is that a handle somebody has just abandoned becomes available
 * to whoever asks for it next. Rapid changes are how an account impersonates one
 * that has just renamed, and how a name is cycled to shake off whatever was
 * attached to the old one. Every platform where a handle carries weight - Discord,
 * Instagram, Twitch - answers this the same way, with a wait.
 *
 * Pure on purpose: a rule about a clock is the one kind of rule worth being able
 * to test without a database or a fixed date. Nothing here reads the time; the
 * caller says what "now" is.
 */

/** The Setting key holding the wait, in days. Absent, the default below applies. */
export const USERNAME_COOLDOWN_KEY = "account.username.cooldown-days";

/**
 * How long an account waits between handle changes when the operator has not
 * said otherwise.
 *
 * Thirty days: long enough that a handle is worth relying on and that cycling
 * one is not a tactic, short enough that somebody who chose badly is not stuck
 * with it for a season. Instagram allows two changes a fortnight and Discord
 * counts per hour; this is the same idea at the scale a deployment this size
 * actually needs.
 */
export const USERNAME_COOLDOWN_DAYS = 30;

/** The largest wait an operator may set, so a typo cannot lock every handle on
 *  the deployment for a decade. A year is already far past anything sensible. */
export const USERNAME_COOLDOWN_MAX_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Read an operator's stored value, falling back to the default for anything
 *  that is not a number in range. Zero is honoured: it means no wait at all. */
export function usernameCooldownDays(stored: string | null | undefined): number {
    if (stored === null || stored === undefined || stored.trim() === "") return USERNAME_COOLDOWN_DAYS;
    const parsed = Number.parseInt(stored, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return USERNAME_COOLDOWN_DAYS;
    return Math.min(parsed, USERNAME_COOLDOWN_MAX_DAYS);
}

/**
 * When this account may next take a different handle, or null when it may now.
 *
 * Null for an account that has never changed one. That covers every account that
 * existed before this rule and every account that has only ever been given the
 * handle it signed up with: a wait imposed retroactively, for something somebody
 * did when there was no rule against it, is a wait nobody can make sense of.
 */
export function usernameChangeAllowedAt(
    lastChangedAt: Date | null | undefined,
    cooldownDays: number = USERNAME_COOLDOWN_DAYS
): Date | null {
    if (!lastChangedAt || cooldownDays <= 0) return null;
    return new Date(lastChangedAt.getTime() + cooldownDays * DAY_MS);
}

/** Whether a change is allowed at `now`. */
export function usernameChangeAllowed(
    lastChangedAt: Date | null | undefined,
    now: Date,
    cooldownDays: number = USERNAME_COOLDOWN_DAYS
): boolean {
    const allowedAt = usernameChangeAllowedAt(lastChangedAt, cooldownDays);
    return allowedAt === null || allowedAt.getTime() <= now.getTime();
}

/**
 * How long is left, written the way somebody would say it.
 *
 * Rounded up, never down: telling somebody to come back in "0 days" when there
 * are eleven hours left is the one answer that is actively wrong. The units stop
 * at days because that is the scale the wait is set in, and "in 3 days" is more
 * use than the exact hour a month from now.
 */
export function usernameCooldownRemaining(allowedAt: Date, now: Date): string {
    const left = allowedAt.getTime() - now.getTime();
    if (left <= 0) return "now";
    const minutes = Math.ceil(left / 60_000);
    if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
    const hours = Math.ceil(left / (60 * 60_000));
    if (hours < 24) return hours === 1 ? "1 hour" : `${hours} hours`;
    const days = Math.ceil(left / DAY_MS);
    return days === 1 ? "1 day" : `${days} days`;
}

/**
 * The sentence somebody gets when they try too soon, or null when they may.
 *
 * Says when rather than only no. A refusal that does not say how long turns into
 * somebody retrying the form every day to find out, which is the same nuisance
 * the wait exists to prevent, pointed at the server instead.
 */
export function usernameChangeRefusal(
    lastChangedAt: Date | null | undefined,
    now: Date,
    cooldownDays: number = USERNAME_COOLDOWN_DAYS
): string | null {
    const allowedAt = usernameChangeAllowedAt(lastChangedAt, cooldownDays);
    if (allowedAt === null || allowedAt.getTime() <= now.getTime()) return null;
    return `You can change your username again in ${usernameCooldownRemaining(allowedAt, now)}.`;
}
