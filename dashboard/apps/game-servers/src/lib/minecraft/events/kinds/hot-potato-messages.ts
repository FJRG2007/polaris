/**
 * What the players read in hot potato, in each reader's language, in the
 * shared palette (`../messages.ts`).
 */

import type { Language } from "../catalog";
import { PALETTE, mark } from "../messages";

const { bad: BAD, good: GOOD, warn: WARN, info: INFO, reason: REASON } = PALETTE;

export function goTitle(language: Language): string {
    return language === "es" ? "&6Patata bomba" : "&6Hot potato";
}

export function goSubtitle(language: Language): string {
    return language === "es"
        ? "&fSi la tienes, golpea a alguien para pasarla"
        : "&fHolding it? Hit somebody to pass it on";
}

export function holderTitle(language: Language): string {
    return language === "es" ? `${BAD}¡Tienes la patata!` : `${BAD}You have the potato!`;
}

export function holderSubtitle(language: Language): string {
    return language === "es" ? "&fGolpea a alguien para pasarla" : "&fHit somebody to pass it on";
}

export function roundLine(round: number, holder: string, language: Language): string {
    return language === "es"
        ? `${WARN}Ronda ${mark(round, WARN)}: la patata la tiene ${mark(holder, WARN)}.`
        : `${WARN}Round ${mark(round, WARN)}: ${mark(holder, WARN)} has the potato.`;
}

export function passed(from: string, to: string, language: Language): string {
    return language === "es"
        ? `${INFO}${mark(from, INFO)} pasa la patata a ${mark(to, INFO)}.`
        : `${INFO}${mark(from, INFO)} passed the potato to ${mark(to, INFO)}.`;
}

export function exploded(name: string, left: number, language: Language): string {
    return language === "es"
        ? `${BAD}¡Bum! ${mark(name, BAD)} queda fuera. ${INFO}Quedan ${mark(left, INFO)}.`
        : `${BAD}Bang! ${mark(name, BAD)} is out. ${INFO}${mark(left, INFO)} left.`;
}

/** Somebody who left the server mid-game is out. */
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

export function holdingBar(seconds: number, language: Language): string {
    return language === "es"
        ? `${BAD}&lTienes la patata ${REASON}- ${Math.ceil(seconds)} s`
        : `${BAD}&lYou have the potato ${REASON}- ${Math.ceil(seconds)}s`;
}

export function awayBar(holder: string, seconds: number, language: Language): string {
    return language === "es"
        ? `${GOOD}Aléjate de ${holder} ${INFO}- ${Math.ceil(seconds)} s`
        : `${GOOD}Keep away from ${holder} ${INFO}- ${Math.ceil(seconds)}s`;
}

export function galleryBar(language: Language): string {
    return language === "es"
        ? `${INFO}Estás fuera: mira desde la grada`
        : `${INFO}You are out: watching from the gallery`;
}

export function nextRoundBar(language: Language): string {
    return language === "es" ? `${WARN}Siguiente ronda...` : `${WARN}Next round...`;
}

/** The boss bar: the round and the fuse. */
export function bar(
    round: number,
    holder: string | null,
    seconds: number,
    language: Language
): string {
    const who = holder ? ` &7- &c${holder}` : "";
    return language === "es"
        ? `&6Ronda ${round}${who} &7- &f${Math.ceil(seconds)} s`
        : `&6Round ${round}${who} &7- &f${Math.ceil(seconds)}s`;
}

export function winner(name: string, language: Language): string {
    return language === "es"
        ? `${GOOD}${mark(name, GOOD)} aguanta hasta el final y gana.`
        : `${GOOD}${mark(name, GOOD)} is the last one left and wins.`;
}

/** Why it ended before its time. */
export const LAST_ONE = "Only one player was left";
