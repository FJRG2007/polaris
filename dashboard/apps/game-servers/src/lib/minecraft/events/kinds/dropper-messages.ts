/**
 * What the players read in a dropper, in each reader's language. Written with `&`
 * colour codes, like the rest of the events' lines (`../messages.ts`).
 */

import type { Language } from "../catalog";

/** Under "Get ready", on the lid. */
export function readySubtitle(language: Language): string {
    return language === "es"
        ? "&fCae por los huecos hasta el agua: no toques ningún piso"
        : "&fFall through the holes to the water: touch no floor";
}

/** Under "Go!", as the lid goes. */
export function goSubtitle(language: Language): string {
    return language === "es" ? "&fGuíate hacia cada hueco" : "&fSteer for each hole";
}

/** Above the hotbar of everybody still falling: the floor they are over, and
 *  the deepest they have been. */
export function bar(floor: number, deepest: number, floors: number, language: Language): string {
    return language === "es"
        ? `&ePiso &f${floor}/${floors} &7- lo más hondo: &f${deepest}`
        : `&eFloor &f${floor}/${floors} &7- deepest so far: &f${deepest}`;
}

/** Said to a player the game sent back up after landing on a floor. */
export function backToTop(language: Language): string {
    return language === "es"
        ? "&cHas tocado un piso: &fde vuelta arriba."
        : "&cYou landed on a floor: &fback to the top.";
}

/** Said when the server cannot play it at all: the data pack that catches a
 *  landing could not be put on. */
export function cannotPlay(language: Language): string {
    return language === "es"
        ? "&cNo se puede jugar al dropper en este servidor ahora: &fno se juega esta vez."
        : "&cThe dropper cannot be played on this server right now: &fnot this time.";
}
