/**
 * What the players read in a villager defense, in each reader's language.
 * Written with `&` colour codes in the shared palette, like the rest of the
 * events' lines (`../messages.ts`); the waves themselves are told with the
 * horde defense's own lines.
 */

import type { Language } from "../catalog";
import type { Heading } from "../commands";
import { HEADING_ES, PALETTE, mark } from "../messages";

const { bad: BAD, good: GOOD, warn: WARN } = PALETTE;

export function pointTitle(language: Language): string {
    return language === "es" ? "&cDefended al aldeano" : "&cDefend the villager";
}

export function pointSubtitle(name: string, language: Language): string {
    return language === "es"
        ? `&f${name} os necesita: que no muera`
        : `&f${name} needs you: keep them alive`;
}

/** Where the villager is, said once it is down. */
export function pointAt(name: string, x: number, y: number, z: number, language: Language): string {
    const where = mark(`X ${x} Y ${y} Z ${z}`, WARN);
    return language === "es"
        ? `${WARN}${mark(name, WARN)} está en ${where}: busca la columna de luz. La primera oleada llega cuando haya alguien allí, y va a por el aldeano.`
        : `${WARN}${mark(name, WARN)} is at ${where}: look for the column of light. The first wave comes once somebody is there, and it goes for the villager.`;
}

/** The bar: the villager's health, then where the waves stand. */
export function bar(name: string, hearts: string, status: string): string {
    return `&6${name} &c${hearts}❤ &7| ${status}`;
}

/** How far the villager is from a player, for anybody away from the point. */
export function guide(name: string, meters: number, heading: Heading, language: Language): string {
    return language === "es"
        ? `&e${name}: &f${meters} m &eal &f${HEADING_ES[heading]}`
        : `&e${name}: &f${meters} m &e${heading}`;
}

export function hurtTitle(language: Language): string {
    return language === "es" ? "&c¡Están hiriendo al aldeano!" : "&cThe villager is hurt!";
}

export function hurtSubtitle(name: string, hearts: string, language: Language): string {
    return language === "es"
        ? `&f${name}: le quedan &c${hearts}❤`
        : `&f${name} has &c${hearts}❤ &fleft`;
}

export function lostTitle(name: string, language: Language): string {
    return language === "es" ? `&c${name} ha muerto` : `&c${name} has died`;
}

export function lostSubtitle(language: Language): string {
    return language === "es" ? "&fNadie gana esta vez" : "&fNobody wins this time";
}

/** At the end, when the villager died: why there is no podium. */
export function lostLine(name: string, wave: number, language: Language): string {
    return language === "es"
        ? `${BAD}${mark(name, BAD)} murió en la oleada ${mark(wave, BAD)}, así que nadie gana ni hay premios.`
        : `${BAD}${mark(name, BAD)} died in wave ${mark(wave, BAD)}, so nobody wins and there are no prizes.`;
}

/** At the end, when it made it through. */
export function savedLine(name: string, language: Language): string {
    return language === "es"
        ? `${GOOD}${mark(name, GOOD)} ha sobrevivido. ¡Gracias por defenderle!`
        : `${GOOD}${mark(name, GOOD)} made it. Thank you for defending them!`;
}
