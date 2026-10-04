/**
 * What the players read in a TNT run, in each reader's language. Written with `&`
 * colour codes, like the rest of the events' lines (`../messages.ts`).
 */

import type { Language } from "../catalog";

/** Under "Get ready", while everybody is brought in. */
export function readySubtitle(language: Language): string {
    return language === "es"
        ? "&fCada bloque que pisas desaparece: no te pares"
        : "&fEvery block you step on vanishes: keep running";
}

export function goTitle(language: Language): string {
    return language === "es" ? "&c&l¡Corre!" : "&c&lRun!";
}

/** Above the hotbar of everybody still standing: how many are, and which of
 *  the floors they are on, counted from the top. */
export function bar(left: number, floor: number, floors: number, language: Language): string {
    return language === "es"
        ? `&eQuedan &f${left} &7- piso &f${floor}/${floors}&7: no te pares`
        : `&f${left} &eleft &7- floor &f${floor}/${floors}&7: keep running`;
}

/** Said when the server cannot play it at all: the data pack that takes the
 *  floor away could not be put on. */
export function cannotPlay(language: Language): string {
    return language === "es"
        ? "&cNo se puede jugar al TNT run en este servidor ahora: &fno se juega esta vez."
        : "&cTNT run cannot be played on this server right now: &fnot this time.";
}
