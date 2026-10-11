/**
 * What the players read in tug of war, in each reader's language, in the
 * shared palette (`../messages.ts`).
 */

import type { Language } from "../catalog";
import { PALETTE, clock, teamName } from "../messages";

const { good: GOOD, warn: WARN, info: INFO } = PALETTE;

/** Under the team's name as they come in. */
export function enterSubtitle(language: Language): string {
    return language === "es"
        ? "&fClic derecho con la caña para tirar de la cuerda"
        : "&fRight-click with the rod to pull the rope";
}

/** Above each player's hotbar while it is played. */
export function statusBar(side: number, pulls: number, language: Language): string {
    return language === "es"
        ? `&lEquipo ${teamName(side, language)} ${INFO}- tus tirones: &f${pulls} ${INFO}- clic derecho para tirar`
        : `&l${teamName(side, language)} team ${INFO}- your pulls: &f${pulls} ${INFO}- right-click to pull`;
}

/** The rope as a gauge, the marker on it: `Red |----#------| Blue`. */
export function gauge(position: number, length: number): string {
    const cells = 21;
    const half = (cells - 1) / 2;
    const at = Math.max(0, Math.min(cells - 1, Math.round(half + (position / length) * half)));
    const rope = Array.from({ length: cells }, (_, index) => (index === at ? "&e&l#&r&7" : "-"));
    return `&c|&7${rope.join("")}&9|`;
}

/** The boss bar: both teams, the rope between them, the time left. */
export function bar(
    position: number,
    length: number,
    secondsLeft: number,
    language: Language
): string {
    return `${teamName(0, language)} ${gauge(position, length)} ${teamName(1, language)} &f- ${clock(secondsLeft)}`;
}

export function wonTitle(side: number, language: Language): string {
    return language === "es"
        ? `${GOOD}Gana el ${teamName(side, language)}`
        : `${teamName(side, language)}${GOOD} team wins`;
}

export function wonSubtitle(language: Language): string {
    return language === "es" ? "&fLos perdedores caen al agua" : "&fThe losers drop into the water";
}

export function won(side: number, timeUp: boolean, language: Language): string {
    if (language === "es")
        return timeUp
            ? `${WARN}Se acabó el tiempo con la cuerda del lado del ${teamName(side, language)}${WARN}: gana.`
            : `${GOOD}El ${teamName(side, language)}${GOOD} arrastra la cuerda hasta su línea y gana.`;
    return timeUp
        ? `${WARN}Time is up with the rope on the ${teamName(side, language)}${WARN} side: they win.`
        : `${GOOD}The ${teamName(side, language)}${GOOD} team pulled the rope over its line and wins.`;
}

/** Said with the results. */
export function result(wonBy: number | null, language: Language): string {
    if (wonBy === null)
        return language === "es"
            ? `${INFO}La cuerda acabó justo en el centro: empate.`
            : `${INFO}The rope ended dead center: a draw.`;
    return language === "es"
        ? `${GOOD}Tira y afloja: gana el equipo ${teamName(wonBy, language)}${GOOD}.`
        : `${GOOD}Tug of war: the ${teamName(wonBy, language)}${GOOD} team wins.`;
}

/** Why it ended before its time, for the run's record. */
export function wonBy(side: number, timeUp: boolean): string {
    const team = side === 0 ? "Red" : "Blue";
    return timeUp
        ? `The ${team} team was ahead when the time ran out`
        : `The ${team} team pulled the rope over its line`;
}
