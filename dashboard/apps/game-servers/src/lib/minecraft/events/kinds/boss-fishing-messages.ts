/**
 * What the players read in a boss fishing, in each reader's language. Written
 * with `&` colour codes in the shared palette, like the rest of the events'
 * lines (`../messages.ts`).
 */

import type { Language } from "../catalog";
import { PALETTE, mark } from "../messages";

const { good: GOOD, warn: WARN, info: INFO } = PALETTE;

export function fishName(language: Language): string {
    return language === "es" ? "El pez legendario" : "The legendary fish";
}

/** The boss bar: its strength left, out of its whole, and the time. */
export function bar(left: number, max: number, clock: string, language: Language): string {
    return `&b${fishName(language)} &f${left}/${max} &7- ${clock}`;
}

export function hookedTitle(language: Language): string {
    return language === "es" ? "&b¡Ha picado algo enorme!" : "&bSomething huge is on the line!";
}

/** At the start: how strong it is, and what wears it down. */
export function hookedLine(strength: number, worth: number, language: Language): string {
    return language === "es"
        ? `${WARN}${fishName(language)} tiene ${mark(strength, WARN)} de fuerza. Cada pez que pesquéis le quita uno, y cada tesoro ${mark(worth, WARN)}.`
        : `${WARN}${fishName(language)} has a strength of ${mark(strength, WARN)}. Every fish you catch takes one off, and every treasure ${mark(worth, WARN)}.`;
}

export function treasureLine(name: string, worth: number, language: Language): string {
    return language === "es"
        ? `${GOOD}${mark(name, GOOD)} ha pescado un tesoro: el pez pierde ${mark(worth, GOOD)}.`
        : `${GOOD}${mark(name, GOOD)} fished up a treasure: the fish loses ${mark(worth, GOOD)}.`;
}

/** It has fallen to a share of its strength (`STAGES`). */
export function tiringLine(percent: number, language: Language): string {
    return language === "es"
        ? `${WARN}El pez se cansa: le queda el ${mark(`${percent}%`, WARN)} de su fuerza.`
        : `${WARN}The fish is tiring: ${mark(`${percent}%`, WARN)} of its strength is left.`;
}

/** More players fishing: it fights for longer. */
export function strongerLine(added: number, language: Language): string {
    return language === "es"
        ? `${INFO}Más gente pescando: el pez aguanta ${mark(added, INFO)} capturas más.`
        : `${INFO}More players fishing: the fish holds out for ${mark(added, INFO)} more catches.`;
}

export function landedTitle(language: Language): string {
    return language === "es" ? "&b¡Pez legendario capturado!" : "&bThe legendary fish is landed!";
}

export function landedSubtitle(language: Language): string {
    return language === "es" ? "&fGana quien más haya pescado" : "&fThe most catches win";
}

/** In the results, when it was landed. */
export function landedLine(language: Language): string {
    return language === "es"
        ? `${GOOD}Entre todos habéis sacado ${fishName(language).toLowerCase()}. ¡Buena pesca!`
        : `${GOOD}Together you landed ${fishName(language).toLowerCase()}. Good fishing!`;
}

export function escapedTitle(language: Language): string {
    return language === "es" ? "&7El pez se ha escapado" : "&7The fish got away";
}

/** In the results, when the time ran out first. */
export function escapedLine(left: number, language: Language): string {
    return language === "es"
        ? `${INFO}${fishName(language)} se escapó con ${mark(left, INFO)} de fuerza. Nadie gana esta vez.`
        : `${INFO}${fishName(language)} got away with ${mark(left, INFO)} strength left. Nobody wins this time.`;
}
