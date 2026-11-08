/**
 * Boosts somebody brought into an event from outside it, taken off while they play.
 *
 * A beacon at home gives speed, haste, resistance, jump boost, strength and
 * regeneration to everybody within reach, renewed every few seconds and lasting
 * a quarter of a minute after they leave. Somebody who walked from their base
 * into a match - or plays one close enough to a beacon to stay in its reach -
 * played it faster, higher and harder to kill than everybody else.
 *
 * A beacon's effects are the game's "ambient" ones, which nothing an event gives
 * ever is (`effect give` cannot make one), so only those are matched: the
 * resistance an arena gives on a respawn and the regeneration a round hands out
 * stay. Conduit power is ambient too and comes off with them. Both spellings of
 * the effect list are asked for - `active_effects` since 1.20.2, `ActiveEffects`
 * with numeric ids before it - and the one a version does not know never matches.
 */

import * as catalog from "./catalog";

/** The tag the pass puts on whoever is playing, read by its own lines only. */
export const PLAYING_TAG = "pe_unboost";

/** What a beacon gives, with the id the effect had before 1.20.2. */
const BEACON_EFFECTS = [
    ["speed", 1],
    ["haste", 3],
    ["strength", 5],
    ["jump_boost", 8],
    ["regeneration", 10],
    ["resistance", 11],
    ["conduit_power", 29]
] as const;

/** Kinds that are a boost for everybody rather than a game somebody plays. */
const NOT_A_MATCH: ReadonlySet<catalog.EventKind> = new Set<catalog.EventKind>([
    "happy-hour",
    "xp-boost"
]);

/** Whether a kind is a game its players should play without outside boosts. */
export function strips(kind: catalog.EventKind): boolean {
    return !NOT_A_MATCH.has(kind);
}

/**
 * The lines that take a beacon's effects off everybody in `players` and nobody
 * else. Names that are not a player's name are left out; nobody left means no
 * lines at all.
 */
export function stripLines(players: Iterable<string>): string[] {
    const names = [...new Set([...players].filter((name) => catalog.PLAYER_NAME.test(name)))];
    if (names.length === 0) return [];
    const lines = [
        `tag @a remove ${PLAYING_TAG}`,
        ...names.map((name) => `tag ${name} add ${PLAYING_TAG}`)
    ];
    for (const [effect, legacy] of BEACON_EFFECTS) {
        lines.push(
            `effect clear @a[tag=${PLAYING_TAG},nbt={active_effects:[{id:"minecraft:${effect}",ambient:1b}]}] minecraft:${effect}`,
            `effect clear @a[tag=${PLAYING_TAG},nbt={ActiveEffects:[{Id:${legacy},Ambient:1b}]}] minecraft:${effect}`
        );
    }
    return lines;
}

/** The tag taken off again when the event is over. */
export const RELEASE_LINE = `tag @a remove ${PLAYING_TAG}`;
