/**
 * Boss fishing: a legendary fish on everybody's line at once, worn down by
 * every catch, with its strength on the boss bar. Landed before the time is
 * up, the most catches win; still fighting when it is up, it gets away and
 * nobody does.
 *
 * Its strength is `catches` for each player fishing when it starts, and grows
 * by as much for each one who starts fishing later, keeping what was already
 * taken off it - as a world boss does (`boss.toppedUp`).
 *
 * How a catch is told from outside the game:
 *
 * - A fish is the fishing contest's own count: the `fish_caught` statistic,
 *   which the game adds to only for a fish.
 * - A treasure is what a rare catch looks for (`rare-catch`): one of the
 *   fishing treasures picked up, less any dropped, within a few looks of
 *   reeling a line in. It is worth `TREASURE_WORTH` catches, and counted by
 *   Polaris into its own objective, since no statistic has it.
 * - A piece of junk counts for nothing.
 *
 * Each player's catches are added up in the game and shown on the side panel.
 * Whoever was AFK from the start, or seen in creative or spectator, wears the
 * fish down for nothing: their catches are left out of its strength, as they
 * are left off the podium (`afkCounts`). And a catch made by anybody AFK at the
 * time never counts, whoever they are: kept on the run (`idle`) and taken off
 * their catches on the side panel, the podium and the fish alike. Moving once
 * does not make what an AFK farm caught before it count, and who is AFK is
 * kept on the run too (`afk`), so neither a restart nor logging off and on -
 * after which nobody is known to be either yet - lifts it.
 *
 * Pure, like the rest of the commands; everything is kept on the server's
 * scoreboard under `pe_fb`, so a Polaris restart finds it where it was.
 */

import { z } from "zod";
import { SCORE } from "../commands";
import { PLAYER_NAME } from "../catalog";
import * as rareCatch from "./rare-catch";

/** What one treasure off the line is worth, in catches. */
export const TREASURE_WORTH = 3;

/** The shares of its strength at which everybody is told it is tiring. */
export const STAGES = [0.75, 0.5, 0.25] as const;

/** Every fishing treasure counts, whichever it is. */
const TREASURES = { treasure: "any" } as const;

/** Fish caught, as the fishing contest counts them. */
const FISH = "pe_fbf";
/** Treasures caught, already times their worth. */
const TREASURE = "pe_fbt";
/** Both together: a player's catches. */
const CATCHES = "pe_fbs";
/** The catches made while AFK, set by Polaris from the run (`idle`). */
const IDLE = "pe_fbi";

/** What a run keeps of its fish. */
export const fishSchema = z.object({
    /** Its whole strength, in catches. */
    max: z.number().int().positive(),
    /** The players it was sized for: those fishing when it started, and since. */
    fishers: z.array(z.string()).default([]),
    /** Each player's catches as last read, kept for whoever goes offline. */
    caught: z.record(z.number().int()).default({}),
    /** Of those, the ones made while they were AFK: never counted. */
    idle: z.record(z.number().int()).default({}),
    /** Who was AFK at the last reading, lowercased: until seen moving. */
    afk: z.array(z.string()).default([]),
    /** How many of `STAGES` have been said. */
    told: z.number().int().default(0),
    /** It was landed: the event ended there. */
    landed: z.boolean().default(false)
});
export type FishState = z.infer<typeof fishSchema>;

/** Its strength for a number of players fishing, never for fewer than one. */
export function strengthFor(catches: number, fishers: number): number {
    return Math.max(1, catches) * Math.max(1, fishers);
}

/** The fish when it takes the line, sized for the players fishing now. */
export function hooked(catches: number, fishers: readonly string[]): FishState {
    return {
        max: strengthFor(catches, fishers.length),
        fishers: [...new Set(fishers)],
        caught: {},
        idle: {},
        afk: [],
        told: 0,
        landed: false
    };
}

/**
 * The fish grown for whoever has started fishing since: `catches` more for
 * each, on top of what it had - what was taken off it stays taken.
 */
export function grown(
    state: FishState,
    catches: number,
    fishing: readonly string[]
): { state: FishState; added: string[] } {
    const known = new Set(state.fishers.map((name) => name.toLowerCase()));
    const added = [...new Set(fishing)].filter((name) => !known.has(name.toLowerCase()));
    if (added.length === 0) return { state, added };
    // Sized for nobody (nobody could be read as it started), it was sized for
    // one: the first to come takes that place.
    const more = added.length - (state.fishers.length === 0 ? 1 : 0);
    return {
        state: {
            ...state,
            max: state.max + Math.max(1, catches) * more,
            fishers: [...state.fishers, ...added]
        },
        added
    };
}

/**
 * Catches as last read, every reading only ever adding: a player who logs off
 * keeps what they caught. What `afk` players (lowercased) caught since the last
 * reading is written down as made while AFK, and never counts.
 */
export function withCatches(
    state: FishState,
    read: ReadonlyMap<string, number>,
    afk: ReadonlySet<string> = new Set()
): FishState {
    const caught = { ...state.caught };
    const idle = { ...state.idle };
    const known = new Map(Object.keys(caught).map((name) => [name.toLowerCase(), name]));
    for (const [name, value] of read) {
        const key = known.get(name.toLowerCase()) ?? name;
        const more = value - (caught[key] ?? 0);
        if (more <= 0) continue;
        caught[key] = value;
        if (afk.has(name.toLowerCase())) idle[key] = (idle[key] ?? 0) + more;
    }
    return { ...state, caught, idle };
}

/**
 * Who is AFK now, lowercased: everybody seen still for the AFK time (`idle`),
 * and whoever was AFK before and has not been seen moving since (`active`) -
 * so a restart, or logging off and on, which leave a player not known to be
 * either for a while, never lifts it.
 */
export function stillAfk(
    before: readonly string[],
    active: ReadonlySet<string>,
    idle: ReadonlySet<string>
): string[] {
    return [...new Set([...idle, ...before.filter((name) => !active.has(name))])].sort();
}

/** What a player's catches count for: those not made while AFK. */
export function counted(state: FishState, name: string): number {
    return Math.max(0, (state.caught[name] ?? 0) - (state.idle[name] ?? 0));
}

/** How much of its strength is left: its whole, less every catch that counts
 *  by anybody not `excluded` (lowercased names). */
export function strengthLeft(state: FishState, excluded: ReadonlySet<string>): number {
    const taken = Object.keys(state.caught)
        .filter((name) => !excluded.has(name.toLowerCase()))
        .reduce((sum, name) => sum + counted(state, name), 0);
    return Math.max(0, state.max - taken);
}

/** How many of `STAGES` its strength has fallen to. */
export function stagesDue(left: number, max: number): number {
    return STAGES.filter((share) => left <= max * share).length;
}

// ------------------------------------------------------------------ the commands

/** The objectives it counts with: a rare catch's for the treasures, and its own. */
export function fishSetup(): string[] {
    const lines = rareCatch.catchSetup(TREASURES);
    const add = (objective: string, criterion: string) =>
        lines.push(
            `scoreboard objectives remove ${objective}`,
            `scoreboard objectives add ${objective} ${criterion}`
        );
    add(FISH, "minecraft.custom:minecraft.fish_caught");
    add(TREASURE, "dummy");
    add(CATCHES, "dummy");
    add(IDLE, "dummy");
    return lines;
}

/** One look for treasures (`rare-catch`): read with `READ_TREASURES`, then
 *  `treasureCommit` makes it the one the next is measured from. */
export function treasureLook(): string[] {
    return rareCatch.catchLook(TREASURES);
}

export const READ_TREASURES = rareCatch.READ_CATCHERS;

export function treasureCommit(): string[] {
    return rareCatch.catchCommit();
}

/** A treasure off `name`'s line, added to their catches. */
export function treasureLine(name: string): string {
    return `scoreboard players add ${name} ${TREASURE} ${TREASURE_WORTH}`;
}

/** Every player's catches added up, and onto the side panel once they have
 *  any - less those made while AFK (`idle`, by name), which never count. */
export function fishTick(idle: Readonly<Record<string, number>> = {}): string[] {
    return [
        `scoreboard players add @a ${TREASURE} 0`,
        `scoreboard players add @a ${IDLE} 0`,
        ...idleLines(idle),
        `execute as @a store result score @s ${CATCHES} run scoreboard players get @s ${FISH}`,
        `execute as @a run scoreboard players operation @s ${CATCHES} += @s ${TREASURE}`,
        `execute as @a[scores={${CATCHES}=1..}] run scoreboard players operation @s ${SCORE} = @s ${CATCHES}`,
        `execute as @a[scores={${CATCHES}=1..}] run scoreboard players operation @s ${SCORE} -= @s ${IDLE}`
    ];
}

/** The catches made while AFK, written where the game takes them off. */
function idleLines(idle: Readonly<Record<string, number>>): string[] {
    return Object.entries(idle)
        .filter(([name, count]) => PLAYER_NAME.test(name) && count > 0)
        .map(([name, count]) => `scoreboard players set ${name} ${IDLE} ${count}`);
}

/** Everybody's catches: `Ana has 7 [pe_fbs]`. */
export const READ_CATCHES = `execute as @a run scoreboard players get @s ${CATCHES}`;

/**
 * The fish landed: a burst of firework sparks over every player, and the
 * sounds of a display. Particles, not rockets: a rocket that bursts hurts
 * whoever is near it, and one fired indoors bursts against the ceiling.
 */
export function landedLines(): string[] {
    const sound = (id: string, pitch: number) =>
        `execute as @a at @s run playsound minecraft:${id} master @s ~ ~ ~ 1 ${pitch}`;
    return [
        "execute at @a run particle minecraft:firework ~ ~2.5 ~ 1.2 1 1.2 0.08 120",
        "execute at @a run particle minecraft:totem_of_undying ~ ~1 ~ 0.6 0.8 0.6 0.4 60",
        sound("entity.firework_rocket.launch", 1),
        sound("entity.firework_rocket.large_blast", 1),
        sound("entity.firework_rocket.twinkle", 1.2),
        sound("ui.toast.challenge_complete", 1)
    ];
}

/** Every objective it makes, taken back out. */
export function fishCleanup(): string[] {
    return [
        ...rareCatch.catchCleanup(),
        ...[FISH, TREASURE, CATCHES, IDLE].map(
            (objective) => `scoreboard objectives remove ${objective}`
        )
    ];
}
