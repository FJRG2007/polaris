/**
 * What the players read in a downhill boat race, in each reader's language,
 * where it differs from the ice boat race's (`boat-race-messages.ts`): it is
 * raced once, down, so there are no laps. Written with `&` colour codes, like
 * the rest of the events' lines (`../messages.ts`).
 */

import type { Language } from "../catalog";

/** Under "Get ready", on the start grid at the top. */
export function readySubtitle(language: Language): string {
    return language === "es"
        ? "&fBaja por cada puerta en orden hasta la meta"
        : "&fDown through every gate in order to the finish";
}

/** Under "Go!", as the boats are handed out. */
export function goSubtitle(language: Language): string {
    return language === "es" ? "&fTodo cuesta abajo" : "&fAll the way down";
}

/** Above the hotbar of everybody still racing. */
export function bar(gate: number, gates: number, language: Language): string {
    return language === "es" ? `&ePuerta &f${gate}/${gates}` : `&eGate &f${gate}/${gates}`;
}

/** Said when the server cannot play it at all: the data pack that counts the
 *  gates could not be put on. */
export function cannotPlay(language: Language): string {
    return language === "es"
        ? "&cNo se puede jugar el descenso en barca en este servidor ahora: &fno se juega esta vez."
        : "&cThe downhill boat race cannot be played on this server right now: &fnot this time.";
}
