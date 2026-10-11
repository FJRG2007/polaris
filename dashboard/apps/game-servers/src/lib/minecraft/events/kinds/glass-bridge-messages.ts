/**
 * What the players read on the glass bridge, in each reader's language, in the
 * shared palette (`../messages.ts`).
 */

import type { Language } from "../catalog";
import { PALETTE, mark } from "../messages";

const { bad: BAD, good: GOOD, warn: WARN, info: INFO, reason: REASON } = PALETTE;

/** Why it ended before its time. */
export const ALL_DONE = "Everybody has crossed or fallen";

export function goTitle(language: Language): string {
    return language === "es" ? "&bPuente de cristal" : "&bGlass bridge";
}

export function goSubtitle(language: Language): string {
    return language === "es"
        ? "&fEn cada fila un panel aguanta y el otro se rompe"
        : "&fIn every row one panel holds and the other breaks";
}

export function waitSubtitle(language: Language): string {
    return language === "es"
        ? "&fEspera tu turno en la salida"
        : "&fWait for your turn on the start";
}

export function orderLine(order: readonly string[], language: Language): string {
    const names = order.map((name) => mark(name, INFO)).join(`${INFO}, `);
    return language === "es"
        ? `${INFO}Orden de salida: ${names}${INFO}.`
        : `${INFO}Order: ${names}${INFO}.`;
}

export function turnTitle(language: Language): string {
    return language === "es" ? `${GOOD}¡Tu turno!` : `${GOOD}Your turn!`;
}

export function turnSubtitle(seconds: number, language: Language): string {
    return language === "es"
        ? `&fTienes ${seconds} s para cada fila`
        : `&fYou have ${seconds}s for each row`;
}

export function turnLine(name: string, language: Language): string {
    return language === "es"
        ? `${INFO}Turno de ${mark(name, INFO)}.`
        : `${INFO}${mark(name, INFO)} is on the bridge.`;
}

export function fell(name: string, rows: number, language: Language): string {
    return language === "es"
        ? `${BAD}${mark(name, BAD)} cae en la fila ${mark(rows + 1, BAD)}.`
        : `${BAD}${mark(name, BAD)} fell at row ${mark(rows + 1, BAD)}.`;
}

export function tooSlow(name: string, language: Language): string {
    return language === "es"
        ? `${BAD}${mark(name, BAD)} se ha quedado quieto demasiado y queda fuera.`
        : `${BAD}${mark(name, BAD)} stood still too long and is out.`;
}

export function crossed(name: string, place: number, seconds: number, language: Language): string {
    return language === "es"
        ? `${GOOD}${mark(name, GOOD)} cruza el puente en ${mark(Math.round(seconds), GOOD)} s (${mark(place, GOOD)}º).`
        : `${GOOD}${mark(name, GOOD)} crossed in ${mark(Math.round(seconds), GOOD)}s (#${mark(place, GOOD)}).`;
}

export function leftGame(name: string, language: Language): string {
    return language === "es"
        ? `${INFO}${mark(name, INFO)} se ha ido y queda fuera.`
        : `${INFO}${mark(name, INFO)} left and is out.`;
}

export function outTitle(language: Language): string {
    return language === "es" ? `${BAD}Fuera` : `${BAD}You are out`;
}

export function outSubtitle(language: Language): string {
    return language === "es"
        ? "&fMira el resto desde la grada"
        : "&fWatch the rest from the gallery";
}

export function crossedTitle(language: Language): string {
    return language === "es" ? `${GOOD}¡Lo has cruzado!` : `${GOOD}You made it across!`;
}

export function walkingBar(
    rows: number,
    steps: number,
    seconds: number | null,
    language: Language
): string {
    const clock = seconds === null ? "" : ` ${REASON}- ${Math.max(0, Math.ceil(seconds))} s`;
    return language === "es"
        ? `${WARN}Fila ${rows} de ${steps}${clock}`
        : `${WARN}Row ${rows} of ${steps}${clock}`;
}

export function waitingBar(name: string | null, language: Language): string {
    if (name === null)
        return language === "es" ? `${INFO}Espera tu turno` : `${INFO}Wait for your turn`;
    return language === "es"
        ? `${INFO}En el puente: ${mark(name, INFO)}`
        : `${INFO}On the bridge: ${mark(name, INFO)}`;
}

export function galleryBar(language: Language): string {
    return language === "es"
        ? `${REASON}Estás fuera: mira desde la grada`
        : `${REASON}You are out: watch from the gallery`;
}

export function finishedBar(language: Language): string {
    return language === "es" ? `${GOOD}Has cruzado` : `${GOOD}You crossed`;
}

export function bar(left: number, crossedCount: number, language: Language): string {
    return language === "es"
        ? `Puente de cristal - quedan ${left}, han cruzado ${crossedCount}`
        : `Glass bridge - ${left} left, ${crossedCount} across`;
}

export function winner(name: string, crossedIt: boolean, language: Language): string {
    if (crossedIt)
        return language === "es"
            ? `${GOOD}${mark(name, GOOD)} es el primero en cruzar el puente de cristal.`
            : `${GOOD}${mark(name, GOOD)} was the first across the glass bridge.`;
    return language === "es"
        ? `${GOOD}Nadie lo ha cruzado; ${mark(name, GOOD)} es quien más lejos ha llegado.`
        : `${GOOD}Nobody made it across; ${mark(name, GOOD)} got the furthest.`;
}
