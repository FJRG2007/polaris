/**
 * Who hit whom in an arena, as the game itself says it.
 *
 * The game's damage statistics were the first way a hit was read, and they
 * miss them: a statistic's score does not exist until it first moves, so the
 * first rise of each one was compared with nothing and dropped; they count a
 * hit in tenths of a heart rounded, so a punch Resistance IV leaves under half
 * a tenth (a quick second click) counts nothing; and `damage_taken` rises for a
 * fall as much as for a blow.
 *
 * So the events data pack (`snowball-pack.ts`) carries two advancements that
 * fire on the hit itself: `entity_hurt_player` on the player hurt by another
 * player, and `player_hurt_entity` on the player who hurt one - any damage
 * that got through, however small after Resistance, and nothing a shield
 * blocked or a fall did. Their rewards tag the player, only one an arena took
 * in, and take the advancement back so the next hit fires it again. The tick
 * takes what was tagged since the last look in one batch (`TAKE`), so a hit
 * that lands while it reads is kept for the next.
 *
 * Who hit a player is the game's own memory of it: `execute on attacker`
 * (1.19.4) is the last living thing that hurt them in the last five seconds.
 * Before it, the nearest of those who struck is all there is.
 *
 * Pure.
 */

/** The tag every player an arena took in carries (`arena.IN_ARENA`). */
const IN_ARENA = "pe_arena";

/** Hurt by a player, and hurt one, since the pack last saw them taken. */
export const HURT_TAG = "pe_hit_hurt";
export const STRUCK_TAG = "pe_hit_struck";
/** The same, as the last look took them: what the tick reads. */
export const WAS_HURT_TAG = "pe_hit_was_hurt";
export const WAS_STRUCK_TAG = "pe_hit_was_struck";

/** The release that has `execute on attacker`. */
export const ON_ATTACKER = [1, 19, 4] as const;

const ADVANCEMENT = {
    hurt: "polaris:hit/hurt",
    struck: "polaris:hit/struck"
} as const;

/** The reward functions, by name under `polaris:hit/`. Vanilla commands every
 *  release from 1.13 reads. */
export const FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
    hurt: [
        `tag @s[tag=${IN_ARENA}] add ${HURT_TAG}`,
        `advancement revoke @s only ${ADVANCEMENT.hurt}`
    ],
    struck: [
        `tag @s[tag=${IN_ARENA}] add ${STRUCK_TAG}`,
        `advancement revoke @s only ${ADVANCEMENT.struck}`
    ]
};

/**
 * The advancements, by name under `polaris:hit/`: no display, so nobody sees
 * them, granted on the hit and taken back by their own reward. A blow a
 * shield stopped is not a hit.
 */
export const ADVANCEMENTS: Readonly<Record<string, unknown>> = {
    hurt: {
        criteria: {
            hit: {
                trigger: "minecraft:entity_hurt_player",
                conditions: {
                    damage: { source_entity: { type: "minecraft:player" }, blocked: false }
                }
            }
        },
        rewards: { function: ADVANCEMENT.hurt }
    },
    struck: {
        criteria: {
            hit: {
                trigger: "minecraft:player_hurt_entity",
                conditions: {
                    entity: { type: "minecraft:player" },
                    damage: { blocked: false }
                }
            }
        },
        rewards: { function: ADVANCEMENT.struck }
    }
};

/**
 * What the pack tagged since the last look, taken in one batch: the last
 * look's copy cleared, this one's made, the live tags cleared. Sent as one
 * batch, nothing else Polaris says comes in between.
 */
export const TAKE: readonly string[] = [
    `tag @a remove ${WAS_HURT_TAG}`,
    `tag @a remove ${WAS_STRUCK_TAG}`,
    `tag @a[tag=${HURT_TAG}] add ${WAS_HURT_TAG}`,
    `tag @a[tag=${STRUCK_TAG}] add ${WAS_STRUCK_TAG}`,
    `tag @a remove ${HURT_TAG}`,
    `tag @a remove ${STRUCK_TAG}`
];

/** Every tag of the pack's, taken off at the end. */
export const TAGS_OFF: readonly string[] = [HURT_TAG, STRUCK_TAG, WAS_HURT_TAG, WAS_STRUCK_TAG].map(
    (tag) => `tag @a remove ${tag}`
);

/** Who last hurt a player, where they are: `<attacker> has the following entity data: [..]`. */
export function attackerLine(victim: string): string {
    return `execute as ${victim} on attacker run data get entity @s Pos`;
}

/** A count the game keeps per player, as the last looks read it. */
export interface Tally {
    readonly seen: Map<string, number>;
    /** Who was on at the last look, in lower case; null before the first. */
    on: ReadonlySet<string> | null;
}

export function tally(): Tally {
    return { seen: new Map(), on: null };
}

/**
 * How much each count rose since the last look, by the name as read. On the
 * first look nothing has risen: after a restart the counts are not known. After
 * it, a count read for the first time of somebody who was on at the last look
 * started from nothing - a statistic's score only exists once it first moves,
 * so its first rise is a rise from 0. Somebody who was not on is only noted:
 * what they come back with may be older than the look.
 */
export function rose(
    tally: Tally,
    scores: ReadonlyMap<string, number>,
    on: ReadonlySet<string>
): Map<string, number> {
    const risen = new Map<string, number>();
    for (const [name, value] of scores) {
        const before = tally.seen.get(name) ?? (tally.on?.has(name.toLowerCase()) ? 0 : undefined);
        if (before !== undefined && value > before) risen.set(name, value - before);
        tally.seen.set(name, value);
    }
    tally.on = new Set([...on].map((name) => name.toLowerCase()));
    return risen;
}

/** The names a count rose for, in lower case. */
export function roseFor(
    tally: Tally,
    scores: ReadonlyMap<string, number>,
    on: ReadonlySet<string>
): Set<string> {
    return new Set([...rose(tally, scores, on).keys()].map((name) => name.toLowerCase()));
}
