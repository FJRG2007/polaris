/**
 * Handing an ARK player experience.
 *
 * One verb, unlike Minecraft's three, and that is the game rather than a
 * shortcut: ARK has `GiveExpToPlayer` and nothing that takes experience away or
 * sets a level. A negative amount is ignored rather than subtracted, so a form
 * offering "remove" would be a button that does nothing - the screen says so
 * instead.
 *
 * Pure, so the command can be tested exactly. It ends up on a console.
 */

/** Enough to take somebody most of the way up on a fast server, and short of the
 *  typo that would put them at the level cap in one go. */
export const MAX_ARK_EXPERIENCE = 1_000_000;

/**
 * The command, ready to run.
 *
 * The two trailing flags are the game's: whether it counts as experience shared
 * by a tribe, and whether the tribe gets a cut. Neither, here - an operator
 * handing a player a level means that player.
 */
export function arkExperienceCommand(playerId: string, amount: number): string {
    if (!/^\d{1,20}$/.test(playerId)) throw new Error("That is not an in-game player id");
    const points = Math.max(1, Math.min(MAX_ARK_EXPERIENCE, Math.trunc(amount)));
    return `GiveExpToPlayer ${playerId} ${points} 0 1`;
}
