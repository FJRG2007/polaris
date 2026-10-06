/**
 * What the players read in a bingo rush, in each reader's language. Written
 * with `&` colour codes in the shared palette, like the rest of the events'
 * lines (`../messages.ts`). The items themselves are named by the game, in each
 * player's own language (`bingo.nameKey`).
 */

import type { Language } from "../catalog";
import { PALETTE, mark } from "../messages";

const { good: GOOD, warn: WARN, info: INFO } = PALETTE;

/** Over the card, when it is shown to everybody at the start. */
export function cardHeader(line: boolean, language: Language): string {
    const goal =
        language === "es"
            ? line
                ? "gana la primera línea completa (fila, columna o diagonal)"
                : "gana el primero que lo complete"
            : line
              ? "the first full line wins (a row, a column or a diagonal)"
              : "the first to fill it wins";
    return language === "es"
        ? `${WARN}El cartón de hoy - ${goal}:`
        : `${WARN}Today's card - ${goal}:`;
}

/** Under the card at the start: what counts. Without it, a player holding a
 *  card item they brought in reads 0 marked and takes the card as broken. */
export function countsFromNow(language: Language): string {
    return language === "es"
        ? `${INFO}Solo cuenta lo que recojas, fabriques o fundas desde ahora, no lo que ya llevas ni lo que saques de un cofre.`
        : `${INFO}Only what you pick up, craft or smelt from now on counts - not what you already carry or take out of a chest.`;
}

/** Over a player's own card, sent to them when they mark something. */
export function yourCard(language: Language): string {
    return language === "es" ? `${INFO}Tu cartón:` : `${INFO}Your card:`;
}

/** Before the items still to find, on the action bar. */
export function missing(language: Language): string {
    return language === "es" ? "Faltan:" : "Missing:";
}

export function winTitle(name: string, language: Language): string {
    return language === "es" ? `&6¡Bingo, ${name}!` : `&6Bingo, ${name}!`;
}

export function winSubtitle(line: boolean, language: Language): string {
    if (language === "es") return line ? "&fHa completado una línea" : "&fHa completado el cartón";
    return line ? "&fA full line" : "&fThe full card";
}

/** In the results: who won it, and how. */
export function wonLine(name: string, line: boolean, language: Language): string {
    if (language === "es")
        return line
            ? `${GOOD}${mark(name, GOOD)} cantó línea primero.`
            : `${GOOD}${mark(name, GOOD)} completó el cartón primero.`;
    return line
        ? `${GOOD}${mark(name, GOOD)} completed a line first.`
        : `${GOOD}${mark(name, GOOD)} filled the card first.`;
}

/** In the results, when time ran out first. */
export function timeUpLine(line: boolean, language: Language): string {
    if (language === "es")
        return line
            ? `${INFO}Nadie completó una línea: gana quien más objetos marcó.`
            : `${INFO}Nadie completó el cartón: gana quien más objetos marcó.`;
    return line
        ? `${INFO}Nobody completed a line: the most items marked wins.`
        : `${INFO}Nobody filled the card: the most items marked wins.`;
}
