/**
 * An event's sounds, as the server's own when it has put one on a moment.
 *
 * An event plays a handful of the game's sounds at fixed moments - the tick of a
 * countdown, the bell at the start, the fanfare for a winner (`SOUNDS` in
 * `events/commands.ts`). Those lines are written with an explicit minimum volume
 * of 0 at the end, which is the game's own default and changes nothing about how
 * they sound, so they can be told apart from the same sound played for any other
 * reason (an announcement, a challenge).
 *
 * When the server has a sound of its own on that moment, such a line goes out as
 * two: the upload for the players whose game has loaded the pack (the tag the
 * mod and the plugin keep, `SOUND_TAG`), the game's sound for everybody else. A
 * player who turned the pack down hears what they always heard, never silence.
 *
 * Pure, so each rewrite is asserted in a test.
 */

import { SOUNDS } from "./events/commands";
import { SOUND_TAG, commandNumber, soundId, type Moment, type SoundUse } from "./sounds";

/** The game sound each event moment plays today. */
export const MOMENT_SOUNDS: Readonly<Record<Exclude<Moment, "join" | "welcome">, string>> = {
    countdown: SOUNDS.tick,
    start: SOUNDS.start,
    win: SOUNDS.win,
    horn: SOUNDS.horn,
    boss: SOUNDS.boss
};

/** By the game sound a marked line plays, the server's own sound for it. */
export type MomentOverrides = ReadonlyMap<string, SoundUse>;

export function momentOverrides(
    moments: Partial<Record<Moment, SoundUse>>,
    keys: ReadonlySet<string>
): MomentOverrides {
    const overrides = new Map<string, SoundUse>();
    for (const [moment, vanilla] of Object.entries(MOMENT_SOUNDS) as [Moment, string][]) {
        const use = moments[moment];
        if (use && keys.has(use.sound)) overrides.set(vanilla, use);
    }
    return overrides;
}

/** A marked event line: who and where, the game sound, its level and pitch. */
const MARKED =
    /^(execute (?:.*?) )run playsound (minecraft:[a-z0-9_.]+) master @s ~ ~ ~ ([0-9]*\.?[0-9]+) ([0-9]*\.?[0-9]+) 0$/;

/**
 * One line as the server gets it: unchanged unless it is a marked event line
 * whose sound the server replaced, and then the two lines described above.
 */
export function withMoments(line: string, overrides: MomentOverrides): string[] {
    if (overrides.size === 0) return [line];
    const marked = MARKED.exec(line);
    if (!marked) return [line];
    const [, context, vanilla, volume, pitch] = marked as unknown as [string, string, string, string, string];
    const use = overrides.get(vanilla);
    if (!use) return [line];
    const level = Math.min(1, Number(volume) * use.volume);
    const tone = Math.min(2, Math.max(0.5, Number(pitch) * use.pitch));
    return [
        `${context}if entity @s[tag=${SOUND_TAG}] run playsound ${soundId(use.sound)} master @s ~ ~ ~ ${commandNumber(level)} ${commandNumber(tone)}`,
        `${context}unless entity @s[tag=${SOUND_TAG}] run playsound ${vanilla} master @s ~ ~ ~ ${volume} ${pitch}`
    ];
}
