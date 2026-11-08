/**
 * The lucky blocks a newcomer to a Lucky blocks server starts with.
 *
 * The Lucky Blocks datapack (lullaby6) hands one out with
 * `loot give <player> loot lucky_blocks:lucky_block`, and the world add-on
 * scatters more through the overworld - but a player who has just arrived has
 * found none yet and has no gold to craft one, so the first minutes were an
 * ordinary survival world. Polaris gives each player a few, once.
 *
 * "Once" is kept by the game rather than by Polaris: a player is tagged when
 * they are given theirs, and the tag is saved with the player, so it survives a
 * restart, a Polaris update and the same player coming back a month later. The
 * lines only ever select players without it, which makes sending them again -
 * every sweep, on every Lucky blocks server - a no-op for everyone already served.
 *
 * Pure: it only decides which servers and builds the lines.
 */

/** The blueprint this is for. */
export const LUCKY_BLUEPRINT = "luckyblock";

/** How many lucky blocks a newcomer is given. */
export const STARTER_BLOCKS = 3;

/** The tag that marks a player as already given theirs. */
export const STARTER_TAG = "polaris.lucky_starter";

/** The datapack's own loot table for one lucky block. */
const LUCKY_LOOT = "lucky_blocks:lucky_block";

/** Where the lines record whether the game gave the loot, between two lines of
 *  one batch. */
export const STARTER_STORAGE = "polaris:lucky_starter";

/** Whether a server is one that gets this: built from the Lucky blocks blueprint
 *  on a generated world. A prebuilt map takes the datapack back off (see
 *  `maps.ts`), so there would be nothing to give. */
export function wantsStarter(blueprintId: unknown, mapId: unknown): boolean {
    return blueprintId === LUCKY_BLUEPRINT && (typeof mapId !== "string" || mapId.length === 0);
}

/**
 * The console lines that give every player not yet tagged their lucky blocks,
 * then tag them - only when the game actually gave them.
 *
 * The batch is one console session, so a give that fails does not stop the tag
 * line after it. A server without the datapack - its download failed, somebody
 * removed it, or it was created before the blueprint carried one - answers every
 * give with an unknown loot table, and an unconditional tag would mark everyone
 * served with nothing in hand, for good. So each give stores whether it worked,
 * the flag is cleared first, and the tag only runs when it is set. A failing
 * command stores nothing on older releases and a failure on newer ones; cleared
 * first, both read as not given. Nobody is tagged, and the next sweep tries again.
 */
export function starterLines(): string[] {
    const newcomers = `@a[tag=!${STARTER_TAG}]`;
    return [
        `data merge storage ${STARTER_STORAGE} {given:0b}`,
        ...Array.from(
            { length: STARTER_BLOCKS },
            () =>
                `execute as ${newcomers} store success storage ${STARTER_STORAGE} given byte 1 run loot give @s loot ${LUCKY_LOOT}`
        ),
        `execute if data storage ${STARTER_STORAGE} {given:1b} run tag ${newcomers} add ${STARTER_TAG}`
    ];
}
