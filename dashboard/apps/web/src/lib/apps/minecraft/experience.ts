/**
 * Changing how much experience a player has.
 *
 * Three verbs, because the game has three and they are genuinely different:
 * handing somebody a level, taking one away, and saying what they are on. The
 * last is the one an operator reaches for after something went wrong - a death
 * nobody could avoid, a test that emptied a bar - and it is the only one that
 * does not depend on knowing what they had.
 *
 * Two units, because the game has two and they are not interchangeable: levels
 * are what a player sees, points are what a level is made of, and the number of
 * points in a level goes up as the levels do. Both are offered rather than
 * converted, since a conversion here would be a guess about a curve the server
 * owns.
 *
 * Pure so the command can be tested exactly. It ends up on a console.
 */

export const EXPERIENCE_UNITS = ["levels", "points"] as const;

export type ExperienceUnit = (typeof EXPERIENCE_UNITS)[number];

/** Give it, take it away, or say what they are on. */
export type ExperienceMode = "add" | "remove" | "set";

/**
 * The most that can be moved at once.
 *
 * Not a rule the game has - it is a bound on a typo. Levels past a few hundred
 * take longer to earn than a server exists for, and the points that back them run
 * into the millions, so this is generous for both and still short of the extra
 * nought that would leave somebody unable to see their own hotbar.
 */
export const MAX_EXPERIENCE = 100_000;

/** A player name as the game writes one. The same rule the rest of the panel
 *  uses; repeated here because this builds a command out of it. */
const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;

export interface ExperienceChange {
    readonly player: string;
    readonly mode: ExperienceMode;
    readonly amount: number;
    readonly unit: ExperienceUnit;
}

/**
 * The command, as argv.
 *
 * Taking experience away is `xp add` with a negative number rather than a verb of
 * its own - the game has no `xp remove` - and setting is its own subcommand.
 * Nothing here converts between the two units or clamps to what the player
 * actually has: the server refuses what it will not do, and inventing a floor
 * here would be a second opinion about somebody else's numbers.
 */
export function experienceCommand(change: ExperienceChange): string[] {
    if (!PLAYER_NAME.test(change.player)) throw new Error("That is not a player name");
    const amount = Math.max(0, Math.min(MAX_EXPERIENCE, Math.trunc(change.amount)));
    if (change.mode === "set") return ["xp", "set", change.player, String(amount), change.unit];
    const signed = change.mode === "remove" ? -amount : amount;
    return ["xp", "add", change.player, String(signed), change.unit];
}
