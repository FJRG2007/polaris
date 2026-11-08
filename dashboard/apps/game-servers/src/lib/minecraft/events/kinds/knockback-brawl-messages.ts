/**
 * What the players read in a knockback brawl, in each reader's language, in
 * the shared palette (`../messages.ts`).
 */

import type { Language } from "../catalog";
import { PALETTE, mark } from "../messages";

const { bad: BAD, good: GOOD, warn: WARN, info: INFO, reason: REASON } = PALETTE;

/** The stick's name, as the operator's own server called it. */
export function stickName(language: Language): string {
    return language === "es" ? "Palo con Empuje" : "Knockback Stick";
}

export function goTitle(language: Language): string {
    return language === "es" ? `${GOOD}¡A empujar!` : `${GOOD}Push!`;
}

export function goSubtitle(language: Language): string {
    return language === "es"
        ? "&fEcha a los demás de la plataforma"
        : "&fKnock everybody else off the platform";
}

/** Why somebody is out, in a line everybody reads. */
export function outLine(
    name: string,
    why: "fell" | "left" | "died" | "gone",
    by: string | null,
    left: number,
    language: Language
): string {
    const who = mark(name, BAD);
    const tail =
        language === "es"
            ? ` ${INFO}Quedan ${mark(left, INFO)}.`
            : ` ${INFO}${mark(left, INFO)} left.`;
    const how =
        language === "es"
            ? why === "gone"
                ? "se ha ido"
                : why === "died"
                  ? "queda fuera"
                  : "sale volando de la plataforma"
            : why === "gone"
              ? "left the game"
              : why === "died"
                ? "is out"
                : "was knocked off the platform";
    return `${BAD}${who} ${how}${by ? ` ${REASON}(${by})` : ""}${BAD}.${tail}`;
}

export function outTitle(language: Language): string {
    return language === "es" ? `${BAD}Fuera` : `${BAD}You are out`;
}

export function outSubtitle(language: Language): string {
    return language === "es"
        ? "&fTus cosas están a salvo; mira desde arriba"
        : "&fYour things are safe; watch from above";
}

export function aliveBar(left: number, kills: number, language: Language): string {
    return language === "es"
        ? `${WARN}Quedan ${left} ${INFO}- derribos: &f${kills}`
        : `${WARN}${left} left ${INFO}- knock-offs: &f${kills}`;
}

export function galleryBar(language: Language): string {
    return language === "es"
        ? `${INFO}Estás fuera: mira desde arriba`
        : `${INFO}You are out: watching from above`;
}

/** The boss bar: who is left and the time. */
export function bar(left: number, clock: string, language: Language): string {
    return language === "es" ? `&6Quedan ${left} &7- &f${clock}` : `&6${left} left &7- &f${clock}`;
}

export function winner(name: string, language: Language): string {
    return language === "es"
        ? `${GOOD}${mark(name, GOOD)} es el último en la plataforma y gana.`
        : `${GOOD}${mark(name, GOOD)} is the last one on the platform and wins.`;
}

/** At the time, more than one still standing: the most knock-offs wins. */
export function winnerOnTime(name: string, kills: number, language: Language): string {
    return language === "es"
        ? `${GOOD}${mark(name, GOOD)} gana con más derribos (${kills}).`
        : `${GOOD}${mark(name, GOOD)} wins with the most knock-offs (${kills}).`;
}

/** The winner's name, as the title everybody in the game sees. */
export function winnerTitle(name: string, language: Language): string {
    return language === "es" ? `${GOOD}¡Gana ${name}!` : `${GOOD}${name} wins!`;
}

export function winnerSubtitle(language: Language): string {
    return language === "es" ? "&fEl mejor empujando" : "&fThe best pusher";
}

/** Why it ended before its time. */
export const LAST_ONE = "Only one player was left on the platform";
