/**
 * The start of every event that takes its players somewhere: nothing begins
 * until everybody it sent there is there.
 *
 * A teleport is not an arrival. A player on a slow connection, or still loading
 * the world around the arena, stands somewhere else for seconds after the
 * command went out - and whoever arrived first had those seconds to themselves:
 * a head start on a race, the circle held alone, the first blocks of a build.
 *
 * So each of these events, once it has sent everybody in, waits here: nobody
 * hurt, nothing counted, the clock not started - until every player it sent is
 * seen standing where they were put (`look`), or `ARRIVAL_MS` has gone by, when
 * it starts without whoever is still missing and says who. Then a 3-2-1
 * countdown for everybody at once (`countdown`), and "Go!" - with everybody put
 * back on their own start spot by the event itself, so nobody who was in first
 * is a step ahead.
 *
 * What is waited for lives in memory: lost on a restart, which sends everybody
 * in again (or finds them there) and waits afresh.
 */

import * as speech from "../../speech";
import * as written from "../messages";
import * as commands from "../commands";

/** What players read, in one language or - given `speech.EVERY` - in every one. */
const messages = speech.spoken(written);

/**
 * How long everybody is waited for before it starts anyway: one player stuck
 * loading the world, or gone, cannot hold the rest for ever.
 */
export const ARRIVAL_MS = 20_000;

/** The countdown before "Go!", in seconds. */
export const COUNTDOWN = 3;

interface Wait {
    readonly since: number;
    /** Who has been seen in place, in lower case: once seen, counted. */
    readonly arrived: Set<string>;
}

const waits = new Map<string, Wait>();

/** Everybody sent in: from now nothing starts until they are all there. */
export function open(runId: string, now: number): void {
    waits.set(runId, { since: now, arrived: new Set() });
}

export function isOpen(runId: string): boolean {
    return waits.has(runId);
}

/** The wait let go of: started, or ended before everybody was in. */
export function forget(runId: string): void {
    waits.delete(runId);
}

/** Whether somebody has been seen in place since the wait began. */
export function hasArrived(runId: string, name: string): boolean {
    return waits.get(runId)?.arrived.has(name.toLowerCase()) ?? false;
}

/** How the wait stands after one look. */
export interface Look {
    readonly arrived: number;
    readonly total: number;
    /** Who has not been seen in place yet, in the order they were given. */
    readonly missing: readonly string[];
    /** Everybody is there, or the wait has run out: time to start. */
    readonly start: boolean;
}

/**
 * One look: whoever stands in place now (`inPlace`) is added to everybody seen
 * there before. Opens the wait if it was not (a restart lost it).
 */
export function look(
    runId: string,
    now: number,
    names: readonly string[],
    inPlace: (name: string) => boolean
): Look {
    let wait = waits.get(runId);
    if (!wait) {
        wait = { since: now, arrived: new Set() };
        waits.set(runId, wait);
    }
    for (const name of names) if (inPlace(name)) wait.arrived.add(name.toLowerCase());
    const missing = names.filter((name) => !wait.arrived.has(name.toLowerCase()));
    return {
        arrived: names.length - missing.length,
        total: names.length,
        missing,
        start: missing.length === 0 || now - wait.since >= ARRIVAL_MS
    };
}

/** Above the hotbar of everybody in while the rest are still on their way. */
export function waitingLine(target: string, look: Look, language: speech.Speech): string {
    return `title ${target} actionbar ${commands.text(
        messages.waitingForAll(look.arrived, look.total, language)
    )}`;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 3, 2, 1 on everybody's screen, a second apart, each with a tick of sound -
 * sent as it goes, so it is on time whatever else the tick does. Answers once
 * the last second is over: "Go!" is the caller's, with whatever it hands out.
 */
export async function countdown(
    send: (lines: string[]) => Promise<void>,
    target: string,
    language: speech.Speech
): Promise<void> {
    for (let left = COUNTDOWN; left > 0; left -= 1) {
        await send([
            `title ${target} times 0 25 5`,
            `title ${target} subtitle ${commands.text(messages.getReady(language))}`,
            `title ${target} title ${commands.text(messages.countdownNumber(left))}`,
            `execute as ${target} at @s run playsound ${commands.SOUNDS.tick} master @s ~ ~ ~ 1 1 0`
        ]);
        await pause(1_000);
    }
}

/** Said with "Go!" when it started without some of them. */
export function startedWithoutLines(look: Look, language: speech.Speech): string[] {
    if (look.missing.length === 0) return [];
    return [commands.say(messages.tag(language) + messages.startedWithout(look.missing, language))];
}
