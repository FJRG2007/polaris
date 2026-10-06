/**
 * What the players read in hide and seek, in each reader's language, in the
 * shared palette (`../messages.ts`).
 */

import type { Language } from "../catalog";
import { PALETTE, mark } from "../messages";

const { bad: BAD, good: GOOD, warn: WARN, info: INFO } = PALETTE;

/** The two teams' names, as the game shows them: one for everybody. */
export function teamNames(language: Language): [string, string] {
    return language === "es" ? ["Buscadores", "Escondidos"] : ["Seekers", "Hiders"];
}

export function hideTitle(language: Language): string {
    return language === "es" ? `${GOOD}¡Escóndete!` : `${GOOD}Hide!`;
}

export function hideSubtitle(seconds: number, language: Language): string {
    return language === "es"
        ? `&fLos buscadores salen en ${seconds} s`
        : `&fThe seekers come out in ${seconds}s`;
}

export function seekTitle(language: Language): string {
    return language === "es" ? `${BAD}Te toca buscar` : `${BAD}You seek`;
}

export function seekSubtitle(seconds: number, language: Language): string {
    return language === "es"
        ? `&fEspera ${seconds} s; luego encuéntralos a golpes`
        : `&fWait ${seconds}s, then find them with a hit`;
}

export function releasedTitle(language: Language): string {
    return language === "es" ? `${BAD}¡Salen los buscadores!` : `${BAD}The seekers are out!`;
}

export function found(hider: string, by: string, left: number, language: Language): string {
    return language === "es"
        ? `${WARN}${mark(by, WARN)} encuentra a ${mark(hider, WARN)}. ${INFO}Quedan ${mark(left, INFO)} escondidos.`
        : `${WARN}${mark(by, WARN)} found ${mark(hider, WARN)}. ${INFO}${mark(left, INFO)} still hidden.`;
}

export function foundTitle(language: Language): string {
    return language === "es" ? `${WARN}Te han encontrado` : `${WARN}You were found`;
}

export function foundSubtitle(language: Language): string {
    return language === "es" ? "&fAhora buscas tú también" : "&fNow you seek too";
}

export function hiddenBar(seconds: number, left: number, language: Language): string {
    return language === "es"
        ? `${GOOD}Escondido ${Math.floor(seconds)} s ${INFO}- quedan ${left}`
        : `${GOOD}Hidden ${Math.floor(seconds)}s ${INFO}- ${left} left`;
}

export function waitBar(seconds: number, language: Language): string {
    return language === "es"
        ? `${BAD}Sales en ${Math.ceil(seconds)} s`
        : `${BAD}You are let out in ${Math.ceil(seconds)}s`;
}

export function seekBar(left: number, language: Language): string {
    return language === "es"
        ? `${BAD}Búscalos ${INFO}- quedan ${left} escondidos`
        : `${BAD}Find them ${INFO}- ${left} still hidden`;
}

/** The boss bar: who is still hidden, and the time. */
export function bar(left: number, clock: string, language: Language): string {
    return language === "es"
        ? `&aEscondidos: ${left} &7- &f${clock}`
        : `&aStill hidden: ${left} &7- &f${clock}`;
}

/** Told to each player at "Go!", with the code that turns minimap radars off. */
export function radarOff(language: Language): string {
    return language === "es"
        ? `${INFO}Los radares del minimapa están apagados en esta partida.`
        : `${INFO}Minimap radars are switched off for this round.`;
}

/** Said with the results. */
export function summary(found: number, hiders: number, language: Language): string {
    return language === "es"
        ? `${INFO}Encontrados ${mark(found, INFO)} de ${mark(hiders, INFO)}.`
        : `${INFO}${mark(found, INFO)} of ${mark(hiders, INFO)} found.`;
}

/** Why it ended before its time. */
export const ALL_FOUND = "Every hider was found";
