/**
 * An event in the season's mood while it is played: what the world's own
 * decorations (`seasonal.ts`) would have shown, which pause while an event
 * runs, given back by the event itself - and only to the people playing it.
 *
 * Halloween: souls and smoke drifting round whoever is in, a bell and the
 * cave's own sounds at the start, a purple boss bar. Winter: snow falling round
 * them, chimes, a bar that goes from red to green. Both: a sound for whoever
 * goes out, and the winner's fireworks over the arena at the end.
 *
 * Commands only, so it works on every server with or without the Polaris mod,
 * and nothing it does stays: no block, no weather, no time of day. Bounded:
 * particles round at most `MOST_SHOWN` players, seen only by those playing
 * (`inTag`), once every `AMBIENCE_MS`; sounds to the players in it; at most
 * `MOST_ROCKETS` rockets, once. What a version cannot show is left out:
 * the soul particles before 1.16, snowflakes before 1.17 - something older
 * the version has takes their place.
 *
 * Out of season, or where the season could not be read, the event has none of
 * it, exactly as before. Pure: every line is a function of what it is given.
 */

import * as speech from "../speech";
import * as written from "./messages";
import { BAR, text } from "./commands";
import type * as stored from "./state";
import * as stage from "./kinds/stage";
import * as arena from "./kinds/arena";
import type * as decor from "./kinds/arena-decor";
import { playsOnStage, type EventKind } from "./catalog";

const messages = speech.spoken(written);

/** The kinds dressed with it: played up in the sky, each with its own arena. */
export const AMBIENT_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
    "spleef",
    "tnt-run",
    "glass-bridge",
    "sky-wars",
    "pillars"
]);

/** How often the particles are drawn, whatever a kind's tick. */
export const AMBIENCE_MS = 2_000;
/** The most players the particles are drawn round in one look. */
export const MOST_SHOWN = 24;
/** The most rockets the winner's fireworks are. */
export const MOST_ROCKETS = 6;
/** How long a rocket climbs before it bursts, in game ticks: well clear of
 *  anybody under it, a burst hurting only within a few blocks. */
const ROCKET_LIFE = 30;

/** The tag whoever is in it carries: a stage's (spleef, TNT run) or an arena's. */
export function inTag(run: stored.EventRun): string {
    return playsOnStage(run.preset) ? stage.IN_ARENA : arena.IN_ARENA;
}

/** The season a run was dressed for, when it is one of these kinds. */
export function ambienceOf(run: stored.EventRun): decor.Dressing | null {
    return AMBIENT_KINDS.has(run.preset.kind) ? run.season : null;
}

/** Whether it has been started: "Go!" given. */
export function playing(run: stored.EventRun): boolean {
    if (run.stage) return run.stage.goAt !== null;
    return run.readyAt !== null;
}

/** How many have gone out of it so far. */
export function outCount(run: stored.EventRun): number {
    if (run.stage) return run.stage.racers.filter((one) => one.outAt !== null).length;
    const out = (run.game as { out?: unknown } | null)?.out;
    return Array.isArray(out) ? out.length : 0;
}

function particle(name: string, up: number, spread: string, count: number, tag: string): string {
    return `execute as @a[tag=${tag},limit=${MOST_SHOWN}] at @s run particle ${name} ~ ~${up} ~ ${spread} 0.01 ${count} normal @a[tag=${tag}]`;
}

/** The particles round whoever is in, for one look. */
export function particleLines(dressing: decor.Dressing, tag: string): string[] {
    const { era } = dressing;
    if (dressing.season === "halloween") {
        return era.soulLanterns
            ? [
                  particle("minecraft:soul", 1, "3 1 3", 4, tag),
                  particle("minecraft:soul_fire_flame", 0, "4 0.2 4", 2, tag)
              ]
            : [
                  particle("minecraft:witch", 1, "3 1 3", 4, tag),
                  particle("minecraft:smoke", 0, "4 0.2 4", 2, tag)
              ];
    }
    return [
        era.snowflakes
            ? particle("minecraft:snowflake", 6, "6 2 6", 12, tag)
            : particle("minecraft:item_snowball", 6, "6 2 6", 8, tag),
        particle("minecraft:end_rod", 2, "4 1 4", 1, tag)
    ];
}

/** The boss bar's color in the season: purple, or red and green by turns. */
export function barColorLine(dressing: decor.Dressing, now: number): string {
    const color =
        dressing.season === "halloween"
            ? "purple"
            : Math.floor(now / (AMBIENCE_MS * 5)) % 2 === 0
              ? "red"
              : "green";
    return `bossbar set ${BAR} color ${color}`;
}

function sound(id: string, tag: string, pitch = 1): string {
    return `execute as @a[tag=${tag}] at @s run playsound ${id} master @s ~ ~ ~ 0.8 ${pitch}`;
}

/** As it starts: the season's sounds and a word, to whoever is in. */
export function startLines(
    dressing: decor.Dressing,
    tag: string,
    language: speech.Speech
): string[] {
    const sounds =
        dressing.season === "halloween"
            ? [
                  sound("minecraft:block.bell.resonate", tag, 0.8),
                  sound("minecraft:ambient.cave", tag)
              ]
            : [
                  sound("minecraft:block.note_block.chime", tag, 1.2),
                  sound("minecraft:block.note_block.bell", tag)
              ];
    return [
        ...sounds,
        `tellraw @a[tag=${tag}] ${text(messages.seasonGreeting(dressing.season, language))}`
    ];
}

/** As somebody goes out: a sound for those still in. */
export function outLines(dressing: decor.Dressing, tag: string): string[] {
    return dressing.season === "halloween"
        ? [sound("minecraft:entity.witch.celebrate", tag, 0.7)]
        : [sound("minecraft:block.note_block.chime", tag, 0.6)];
}

/**
 * What a look of play adds: the particles every `AMBIENCE_MS`, the bar's color,
 * the start's sounds as it starts and a sound for each look somebody went out.
 */
export function tickLines(
    before: stored.EventRun,
    after: stored.EventRun,
    now: number,
    tickMs: number,
    language: speech.Speech
): string[] {
    const dressing = ambienceOf(after);
    if (!dressing) return [];
    const tag = inTag(after);
    const lines = [barColorLine(dressing, now)];
    if (!playing(after)) return lines;
    if (!playing(before)) lines.push(...startLines(dressing, tag, language));
    else if (outCount(after) > outCount(before)) lines.push(...outLines(dressing, tag));
    // Once in every stretch of `AMBIENCE_MS`, however long a tick is.
    if (Math.floor(now / AMBIENCE_MS) !== Math.floor((now - tickMs) / AMBIENCE_MS))
        lines.push(...particleLines(dressing, tag));
    return lines;
}

interface Corners {
    readonly x1: number;
    readonly y1: number;
    readonly z1: number;
    readonly x2: number;
    readonly y2: number;
    readonly z2: number;
    readonly scenery?: true;
}

/** Where the winner's fireworks go up: over the middle of the arena, from
 *  the top of what it took. Null when nothing of it is written down. */
export function skyOver(run: stored.EventRun): stored.Point | null {
    const boxes: readonly Corners[] = run.arena
        ? [run.arena.box]
        : (run.stage?.boxes ?? []).filter((one) => !one.scenery);
    if (boxes.length === 0) return null;
    const low = (axis: "x" | "z") =>
        Math.min(...boxes.map((one) => Math.min(one[`${axis}1`], one[`${axis}2`])));
    const high = (axis: "x" | "y" | "z") =>
        Math.max(...boxes.map((one) => Math.max(one[`${axis}1`], one[`${axis}2`])));
    return {
        x: Math.floor((low("x") + high("x")) / 2),
        y: high("y") + 2,
        z: Math.floor((low("z") + high("z")) / 2)
    };
}

/** The season's colors for a burst, as the game writes a color (RGB as one number). */
const BURST_COLORS: Readonly<Record<decor.Dressing["season"], readonly number[]>> = {
    halloween: [0xff8000, 0x8000ff, 0x40ff40],
    winter: [0xff2020, 0x20c040, 0xffffff]
};

/** One rocket, written the way this server reads an item. */
function rocket(dressing: decor.Dressing, at: stored.Point, index: number): string {
    const angle = (index / MOST_ROCKETS) * 2 * Math.PI;
    const x = at.x + Math.round(Math.cos(angle) * 4);
    const z = at.z + Math.round(Math.sin(angle) * 4);
    const colors = BURST_COLORS[dressing.season];
    const color = colors[index % colors.length]!;
    const fade = colors[(index + 1) % colors.length]!;
    const item = dressing.era.components
        ? `{id:"minecraft:firework_rocket",count:1,components:{"minecraft:fireworks":{flight_duration:1,explosions:[{shape:"large_ball",colors:[I;${color}],fade_colors:[I;${fade}],has_twinkle:true}]}}}`
        : `{id:"minecraft:firework_rocket",Count:1b,tag:{Fireworks:{Flight:1b,Explosions:[{Type:1b,Colors:[I;${color}],FadeColors:[I;${fade}],Flicker:1b}]}}}`;
    return `execute in minecraft:overworld run summon minecraft:firework_rocket ${x} ${at.y} ${z} {LifeTime:${ROCKET_LIFE},FireworksItem:${item}}`;
}

/**
 * The end, once there is a winner: the rockets over the arena while it still
 * stands and everybody is in it, a sound, and the winner named in the season's
 * colors to everybody. Nothing without a season or a winner.
 */
export function winLines(
    run: stored.EventRun,
    winner: string | null,
    language: speech.Speech
): string[] {
    const dressing = ambienceOf(run);
    if (!dressing || !winner) return [];
    const tag = inTag(run);
    const at = skyOver(run);
    const rockets = at
        ? Array.from({ length: MOST_ROCKETS }, (_, index) => rocket(dressing, at, index))
        : [];
    const sounds =
        dressing.season === "halloween"
            ? [sound("minecraft:entity.witch.celebrate", tag, 1.2)]
            : [
                  sound("minecraft:entity.firework_rocket.twinkle", tag),
                  sound("minecraft:block.note_block.bell", tag, 1.5)
              ];
    return [
        ...rockets,
        ...sounds,
        `tellraw @a ${text(messages.seasonWin(dressing.season, winner, language))}`
    ];
}
