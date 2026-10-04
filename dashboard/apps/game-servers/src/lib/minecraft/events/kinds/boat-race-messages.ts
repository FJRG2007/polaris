/**
 * What the players read in an ice boat race, in each reader's language. Written
 * with `&` colour codes, like the rest of the events' lines (`../messages.ts`).
 */

import type { Language } from "../catalog";

/** Under "Get ready", on the start grid. */
export function readySubtitle(language: Language): string {
    return language === "es"
        ? "&fPasa por cada puerta en orden: no hay atajos"
        : "&fPass every gate in order: no shortcuts";
}

/** Under "Go!", as the boats are handed out. */
export function goSubtitle(laps: number, language: Language): string {
    return language === "es"
        ? `&f${laps} ${laps === 1 ? "vuelta" : "vueltas"}`
        : `&f${laps} ${laps === 1 ? "lap" : "laps"}`;
}

/** Above the hotbar of everybody still racing. */
export function bar(
    lap: number,
    laps: number,
    gate: number,
    gates: number,
    language: Language
): string {
    return language === "es"
        ? `&eVuelta &f${lap}/${laps} &7- &epuerta &f${gate}/${gates}`
        : `&eLap &f${lap}/${laps} &7- &egate &f${gate}/${gates}`;
}

/** Fell off the track. */
export function fell(language: Language): string {
    return language === "es"
        ? "&7De vuelta a tu última puerta, con un barco nuevo."
        : "&7Back to your last gate, in a new boat.";
}

/** Out of the boat. */
export function lost(language: Language): string {
    return language === "es"
        ? "&eHas dejado el barco: &fde vuelta a tu última puerta con uno nuevo."
        : "&eYou left your boat: &fback to your last gate in a new one.";
}

/** Seen at a gate out of turn. */
export function cut(language: Language): string {
    return language === "es"
        ? "&cSin atajos: &fde vuelta a tu última puerta."
        : "&cNo shortcuts: &fback to your last gate.";
}

/** Said when the server cannot play it at all: the data pack that counts the
 *  gates could not be put on. */
export function cannotPlay(language: Language): string {
    return language === "es"
        ? "&cNo se puede jugar la carrera de barcos en este servidor ahora: &fno se juega esta vez."
        : "&cThe boat race cannot be played on this server right now: &fnot this time.";
}
