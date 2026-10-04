/**
 * What the players read in capture the flag, in each reader's language, in the
 * shared palette (`../messages.ts`).
 */

import type { Language } from "../catalog";
import { PALETTE, mark, teamName } from "../messages";

const { bad: BAD, good: GOOD, warn: WARN, info: INFO, reason: REASON } = PALETTE;

/** Under the team's name as they come in. */
export function enterSubtitle(captures: number, language: Language): string {
    return language === "es"
        ? `&fLleva su bandera a tu base: gana quien haga ${captures}`
        : `&fBring their flag to yours: ${captures} to win`;
}

export function took(name: string, side: number, language: Language): string {
    return language === "es"
        ? `${WARN}${mark(name, WARN)} tiene la bandera del ${teamName(side, language)}${WARN}.`
        : `${WARN}${mark(name, WARN)} has the ${teamName(side, language)}${WARN} flag.`;
}

export function dropped(name: string, side: number, language: Language): string {
    return language === "es"
        ? `${BAD}${mark(name, BAD)} suelta la bandera del ${teamName(side, language)}${BAD}; vuelve a su base.`
        : `${BAD}${mark(name, BAD)} dropped the ${teamName(side, language)}${BAD} flag; it is back at its base.`;
}

/** A carrier gone - off the server, or out of the arena: the flag goes home. */
export function returned(side: number, language: Language): string {
    return language === "es"
        ? `${INFO}La bandera del ${teamName(side, language)}${INFO} vuelve a su base.`
        : `${INFO}The ${teamName(side, language)}${INFO} flag is back at its base.`;
}

export function captured(
    name: string,
    side: number,
    red: number,
    blue: number,
    language: Language
): string {
    const score = `${teamName(0, language)} ${red} ${INFO}- &9${blue} ${teamName(1, language)}`;
    return language === "es"
        ? `${GOOD}${mark(name, GOOD)} captura la bandera del ${teamName(side, language)}${GOOD}. ${score}`
        : `${GOOD}${mark(name, GOOD)} captured the ${teamName(side, language)}${GOOD} flag. ${score}`;
}

export function capturedTitle(side: number, language: Language): string {
    return language === "es"
        ? `${GOOD}Captura del ${teamName(side, language)}`
        : `${GOOD}${teamName(side, language)}${GOOD} captures`;
}

/** Above the carrier's hotbar: home, and only while their own flag is there. */
export function carryingBar(ownHome: boolean, language: Language): string {
    if (language === "es")
        return ownHome
            ? `${WARN}&lLlevas la bandera ${REASON}- llévala a tu base`
            : `${WARN}&lLlevas la bandera ${BAD}- recupera la tuya para capturar`;
    return ownHome
        ? `${WARN}&lYou have the flag ${REASON}- take it to your base`
        : `${WARN}&lYou have the flag ${BAD}- get yours back to capture`;
}

/** Above everybody else's hotbar. */
export function statusBar(side: number, captures: number, language: Language): string {
    return language === "es"
        ? `&lEquipo ${teamName(side, language)} ${INFO}- tus capturas: &f${captures}`
        : `&l${teamName(side, language)} team ${INFO}- your captures: &f${captures}`;
}

/** Why it ended before its time: a team reached the captures set. */
export function wonBy(side: number): string {
    return `The ${side === 0 ? "Red" : "Blue"} team reached its captures`;
}
