/**
 * Players not in an event kept from changing it - from the tick, with nothing
 * but the game's own commands, so it needs no restart (the mod's guard, which
 * also refuses hits, explosions and fluids, is the other half).
 *
 * - **Near it, adventure mode.** Whoever comes within `MARGIN` blocks of the
 *   event's space and not taking part is put in adventure mode, where nothing
 *   can be placed, broken or used, and tagged `HELD`. The game mode they had
 *   is written down on the run first (`EventRun.heldOut`) and given back once
 *   they are `LET_GO` blocks further off, and at the event's end; whoever was
 *   not on to be given it back is owed it when they are next seen. Giving it back only ever
 *   touches somebody still tagged `HELD`, still in adventure mode and carrying
 *   neither event tag, so nobody's mode is changed twice and no entrant's is
 *   changed at all.
 * - **Inside it, moved out.** Whoever is not taking part and stands in the
 *   space itself is set down on the ground beside its nearest side, past the
 *   margin, with a few seconds of slow falling (`spreadplayers`, which keeps
 *   off fluids: when there is nowhere it can, they stay, held, and are tried
 *   again next tick).
 *
 * Who takes part is decided twice: the events' own tags in the selector, and
 * the run's names (`insiders`) - entrants, joiners, a stage's players - so an
 * entrant from before the tags is never moved out either. Creative players are
 * held like anybody else; spectators are left alone, since they can touch
 * nothing. Pure: asserted in tests.
 */

import * as stage from "./stage";
import * as arena from "./arena";
import { text } from "../commands";
import { GAMEMODES, HELD_OUT_REASON, type HeldOut } from "../state";
import { PLAYER_NAME } from "../catalog";

type Gamemode = (typeof GAMEMODES)[number];
type Point = { readonly x: number; readonly y: number; readonly z: number };
type Seen = Point & { readonly name: string };

/** Blocks round an event's space in which somebody not in it is held. */
export const MARGIN = 6;
/** How much further off they have to be to be let go: nobody on the edge is
 *  held and let go tick after tick. */
export const LET_GO = 3;
/** How far past the margin somebody moved out is set down. */
const OUT = 4;
/** How far `spreadplayers` may wander from that point. */
const SPREAD = 2;
/** The tag on everybody held, and only while held. */
export const HELD = "pe_held";
/** The most held players a run keeps track of. */
export const HELD_MAX = 200;

/** A player's size, as the game measures it standing. */
const WIDTH = 0.6;
const HEIGHT = 1.8;

const lower = (name: string) => name.toLowerCase();

/** A volume with its corners the low one first. */
export function normal(volume: stage.Volume): stage.Volume {
    return {
        x1: Math.min(volume.x1, volume.x2),
        y1: Math.min(volume.y1, volume.y2),
        z1: Math.min(volume.z1, volume.z2),
        x2: Math.max(volume.x1, volume.x2),
        y2: Math.max(volume.y1, volume.y2),
        z2: Math.max(volume.z1, volume.z2)
    };
}

/**
 * The space an event keeps outsiders out of, or null while it has none: an
 * arena's box, or a stage's volume - proved empty, or failing that what it
 * built once it has.
 */
export function guardedVolume(
    arenaBox: stage.Volume | null,
    built: Pick<stage.StageState, "proved" | "boxes" | "built"> | null
): stage.Volume | null {
    if (arenaBox) return normal(arenaBox);
    if (!built) return null;
    if (built.proved) return normal(built.proved);
    return built.built ? stage.boundsOf(built.boxes) : null;
}

function grown(volume: stage.Volume, by: number): stage.Volume {
    const at = normal(volume);
    return {
        x1: at.x1 - by,
        y1: at.y1 - by,
        z1: at.z1 - by,
        x2: at.x2 + by,
        y2: at.y2 + by,
        z2: at.z2 + by
    };
}

/**
 * Everybody within the margin and `LET_GO` past it who carries neither event's tag and is not a
 * spectator, with where they stand. The selector's box runs from its corner
 * to `d + 1` past it, so `dx = x2 - x1` takes in the last block too.
 */
export function nearRead(volume: stage.Volume): string {
    const at = grown(volume, MARGIN + LET_GO);
    const box = `x=${at.x1},y=${at.y1},z=${at.z1},dx=${at.x2 - at.x1},dy=${at.y2 - at.y1},dz=${at.z2 - at.z1}`;
    return `execute in minecraft:overworld as @a[${box},tag=!${arena.IN_ARENA},tag=!${stage.IN_ARENA},gamemode=!spectator] run data get entity @s Pos`;
}

/** Whether a player with their feet at `at` has any of their body in the volume. */
export function bodyIn(volume: stage.Volume, at: Point): boolean {
    const v = normal(volume);
    const touches = (from: number, size: number, low: number, high: number) =>
        from + size > low && from < high;
    return (
        touches(at.x - WIDTH / 2, WIDTH, v.x1, v.x2 + 1) &&
        touches(at.z - WIDTH / 2, WIDTH, v.z1, v.z2 + 1) &&
        touches(at.y, HEIGHT, v.y1, v.y2 + 1)
    );
}

/**
 * Where somebody inside is set down: past the margin off the side nearest to
 * them, level with where they stand along it. Never in the volume or its
 * margin, whatever `spreadplayers` picks within `SPREAD` of it.
 */
export function outPoint(volume: stage.Volume, at: Point): { x: number; z: number } {
    const v = normal(volume);
    const past = MARGIN + LET_GO + OUT + SPREAD;
    const clampX = Math.min(Math.max(Math.floor(at.x), v.x1), v.x2);
    const clampZ = Math.min(Math.max(Math.floor(at.z), v.z1), v.z2);
    const sides = [
        { gap: at.x - v.x1, x: v.x1 - past, z: clampZ },
        { gap: v.x2 + 1 - at.x, x: v.x2 + past, z: clampZ },
        { gap: at.z - v.z1, x: clampX, z: v.z1 - past },
        { gap: v.z2 + 1 - at.z, x: clampX, z: v.z2 + past }
    ];
    const nearest = sides.reduce((best, one) => (one.gap < best.gap ? one : best));
    return { x: nearest.x, z: nearest.z };
}

/** Out of the space: a few seconds of slow falling, then onto the ground beside it. */
export function moveOutLines(name: string, to: { x: number; z: number }): string[] {
    return [
        `effect give ${name} minecraft:slow_falling 10 0 true`,
        `execute in minecraft:overworld run spreadplayers ${to.x + 0.5} ${to.z + 0.5} 0 ${SPREAD} false ${name}`
    ];
}

/**
 * Held: tagged, then in adventure mode from the mode they were in - and only
 * from it, so a mode changed between the read and now is left as it is. A
 * creative player loses flight with it, so they float down.
 */
export function holdLines(name: string, mode: Gamemode, note: string): string[] {
    const lines = [`tag @a[name=${name},gamemode=${mode}] add ${HELD}`];
    if (mode === "survival" || mode === "creative")
        lines.push(`gamemode adventure @a[name=${name},tag=${HELD},gamemode=${mode}]`);
    if (mode === "creative") lines.push(`effect give ${name} minecraft:slow_falling 10 0 true`);
    lines.push(`tellraw ${name} ${text(note)}`);
    return lines;
}

/** Their own game mode back - only while they are still held, in adventure
 *  mode and in no event - and the tag off. */
export function releaseLines(held: HeldOut): string[] {
    return [
        `gamemode ${held.mode} @a[name=${held.name},tag=${HELD},tag=!${arena.IN_ARENA},tag=!${stage.IN_ARENA},gamemode=adventure]`,
        `tag ${held.name} remove ${HELD}`
    ];
}

/** Who near it is not taking part, of those read in the margin. */
export function outsidersOf(near: readonly Seen[], insiders: ReadonlySet<string>): Seen[] {
    const seen = new Set<string>();
    return near.filter((one) => {
        const key = lower(one.name);
        if (!PLAYER_NAME.test(one.name) || insiders.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Of the outsiders near it, whose game mode has to be read: nobody held now. */
export function toRead(outsiders: readonly Seen[], held: readonly HeldOut[]): string[] {
    const holding = new Set(held.filter((one) => one.holding).map((one) => lower(one.name)));
    return outsiders.filter((one) => !holding.has(lower(one.name))).map((one) => one.name);
}

/**
 * One tick's worth: who is newly held, who is let go, who is moved out, and
 * the run's list as it is afterwards. `modes` holds the game mode just read
 * for each one `toRead` named; somebody whose mode could not be read is not
 * held this tick, only moved out if they are in.
 */
export function step(input: {
    /** None once the space is gone: everybody held is let go. */
    readonly volume: stage.Volume | null;
    readonly outsiders: readonly Seen[];
    readonly modes: ReadonlyMap<string, Gamemode>;
    readonly held: readonly HeldOut[];
    /** What each is told as they are held, and as they are moved out. */
    readonly notes: { readonly held: string; readonly movedOut: string };
}): { lines: string[]; held: HeldOut[]; changed: boolean } {
    const lines: string[] = [];
    const volume = input.volume;
    const read = new Map(input.outsiders.map((one) => [lower(one.name), one]));
    let changed = false;
    const held = input.held.map((one) => {
        if (!one.holding || (volume && read.has(lower(one.name)))) return one;
        // Further off, taking part, or gone: let go. Whoever is not on keeps
        // the tag and is let go at the end, or when next seen (`owedRelease`).
        lines.push(...releaseLines(one));
        changed = true;
        return { ...one, holding: false };
    });
    if (!volume) return { lines, held, changed };
    const margin = grown(volume, MARGIN);
    const index = new Map(held.map((one, at) => [lower(one.name), at]));
    for (const one of input.outsiders) {
        const at = index.get(lower(one.name));
        const before = at === undefined ? undefined : held[at]!;
        if (before?.holding) {
            // Out of creative, so no flight: kept floating while held.
            if (before.mode === "creative")
                lines.push(`effect give ${one.name} minecraft:slow_falling 10 0 true`);
        } else if (bodyIn(margin, one)) {
            const read = input.modes.get(one.name);
            // Still in adventure from the last time, never let go (they were
            // off): what they had then is what they get back.
            const mode = before && read === "adventure" ? before.mode : read;
            if (mode) {
                lines.push(...holdLines(one.name, mode, input.notes.held));
                const entry: HeldOut = { name: one.name, mode, holding: true };
                if (at === undefined) {
                    index.set(lower(one.name), held.length);
                    held.push(entry);
                } else held[at] = entry;
                changed = true;
            }
        }
        if (bodyIn(volume, one)) {
            lines.push(
                ...moveOutLines(one.name, outPoint(volume, one)),
                `tellraw ${one.name} ${text(input.notes.movedOut)}`
            );
        }
    }
    return { lines, held: capped(held), changed };
}

/** The list kept to `HELD_MAX`, the oldest let go first: nobody still held is
 *  dropped while somebody let go is kept. */
function capped(held: HeldOut[]): HeldOut[] {
    const over = held.length - HELD_MAX;
    if (over <= 0) return held;
    const dropped = new Set(held.filter((one) => !one.holding).slice(0, over));
    return held.filter((one) => !dropped.has(one)).slice(-HELD_MAX);
}

/** The mode somebody held is to be written down with if the event takes them
 *  in now: the one they had before they were held. */
export function trueMode(held: readonly HeldOut[], name: string): Gamemode | undefined {
    return held.find((one) => one.holding && lower(one.name) === lower(name))?.mode;
}

/** How a game mode reads in a player's data (`playerGameType`). */
const MODE_NUMBER: Readonly<Record<Gamemode, number>> = {
    survival: 0,
    creative: 1,
    adventure: 2,
    spectator: 3
};

/** Game modes as read (`stage.readGameModes`), with whoever is held given the
 *  one they had before. */
export function withTrueModes(
    read: ReadonlyMap<string, number>,
    held: readonly HeldOut[]
): Map<string, number> {
    const modes = new Map(read);
    for (const name of read.keys()) {
        const mode = trueMode(held, name);
        if (mode) modes.set(name, MODE_NUMBER[mode]);
    }
    return modes;
}

/** Everybody this run held, let go at its end - whoever is on now. */
export function releaseAll(held: readonly HeldOut[]): string[] {
    return held.filter((one) => PLAYER_NAME.test(one.name)).flatMap(releaseLines);
}

/** The same, owed to whoever was not on to be let go (`OwedLines`). Harmless to
 *  anybody already let go: the lines need the tag still on. */
export function owedRelease(
    held: readonly HeldOut[],
    until: number
): { player: string; reason: string; lines: string[]; until: number }[] {
    return held
        .filter((one) => PLAYER_NAME.test(one.name))
        .map((one) => ({
            player: one.name,
            reason: HELD_OUT_REASON,
            lines: releaseLines(one),
            until
        }));
}
