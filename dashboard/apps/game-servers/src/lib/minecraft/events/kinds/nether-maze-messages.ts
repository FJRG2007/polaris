/**
 * What the players read in a deadly nether maze, in each reader's language.
 * Written with `&` colour codes, like the rest of the events' lines
 * (`../messages.ts`).
 */

import type { Language } from "../catalog";

/** Under "Get ready", in the starting room: of a maze of `levels` floors. */
export function readySubtitle(language: Language, levels = 1): string {
    if (levels > 1)
        return language === "es"
            ? "&fSube planta a planta hasta el centro de la última: el fuego y la lava te devuelven"
            : "&fClimb floor by floor to the top one's middle: fire and lava send you back";
    return language === "es"
        ? "&fLlega a la sala del centro: el fuego, el magma y la lava te devuelven"
        : "&fReach the middle room: fire, magma and lava send you back";
}

/** Under "Go!", as the door opens. */
export function goSubtitle(language: Language, levels = 1): string {
    if (levels > 1) return language === "es" ? "&fEncuentra la escalera" : "&fFind the stairs up";
    return language === "es" ? "&fEncuentra el centro" : "&fFind the middle";
}

/** Above the hotbar of everybody still in the maze. */
export function bar(closer: number, rooms: number, language: Language): string {
    return language === "es"
        ? `&eMás cerca: &f${closer}/${rooms} &esalas`
        : `&eCloser: &f${closer}/${rooms} &erooms`;
}

/** Touched fire, magma or lava. */
export function burned(language: Language): string {
    return language === "es"
        ? "&cTe has quemado: &fde vuelta al comienzo de esta planta."
        : "&cYou got burned: &fback to where this floor starts.";
}

/** Told to each racer as they are brought in, with the minimap code. */
export function radarOff(language: Language): string {
    return language === "es"
        ? "&7La vista de cuevas y el radar del minimapa están apagados en el laberinto."
        : "&7Minimap cave view and radar are switched off in the maze.";
}

/** Said when the server cannot play it at all: the data pack that watches the
 *  hazards could not be put on. */
export function cannotPlay(language: Language): string {
    return language === "es"
        ? "&cNo se puede jugar el laberinto en este servidor ahora: &fno se juega esta vez."
        : "&cThe maze cannot be played on this server right now: &fnot this time.";
}
