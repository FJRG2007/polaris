/**
 * What the players read in an elytra race, in each reader's language. Written
 * with `&` colour codes, like the rest of the events' lines (`../messages.ts`).
 */

import type { Language } from "../catalog";

/** Under "Get ready", on the pad. */
export function readySubtitle(language: Language): string {
    return language === "es"
        ? "&fEl suelo cae en la salida: abre las alas y cruza los aros"
        : "&fThe floor drops at the start: open your wings and fly the rings";
}

/** Under "Go!", as the pad goes. */
export function goSubtitle(language: Language): string {
    return language === "es"
        ? "&fSalta y planea: cada aro y cada propulsor dan cohetes"
        : "&fJump and glide: every ring and booster gives rockets";
}

/** Above the hotbar: the lap, the rings passed on it, and how far the next is. */
export function bar(
    lap: number,
    laps: number,
    ring: number,
    rings: number,
    meters: number,
    rise: number,
    language: Language
): string {
    const up = rise > 0 ? `+${rise}` : `${rise}`;
    return language === "es"
        ? `&eVuelta &f${lap}/${laps} &7| &eAros &f${ring}/${rings} &7| &eSiguiente &f${meters} m &7(${up})`
        : `&eLap &f${lap}/${laps} &7| &eRings &f${ring}/${rings} &7| &eNext &f${meters} m &7(${up})`;
}

/** Fell below the course, or landed on something. */
export function fell(language: Language): string {
    return language === "es"
        ? "&cHas caído o aterrizado: &fde vuelta a tu último aro."
        : "&cYou fell or landed: &fback to your last ring.";
}

/** Flew through a ring out of turn. */
export function cut(language: Language): string {
    return language === "es"
        ? "&cEse no era tu siguiente aro: &fde vuelta al último."
        : "&cThat was not your next ring: &fback to your last one.";
}

/** Said when the server cannot play it at all: the data pack that counts the
 *  rings could not be put on. */
export function cannotPlay(language: Language): string {
    return language === "es"
        ? "&cNo se puede jugar la carrera de élitros en este servidor ahora: &fno se juega esta vez."
        : "&cThe elytra race cannot be played on this server right now: &fnot this time.";
}
