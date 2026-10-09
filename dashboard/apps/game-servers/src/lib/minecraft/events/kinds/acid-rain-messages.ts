/**
 * What the players read in an acid rain, in each reader's language. Written
 * with `&` colour codes, like the rest of the events' lines (`../messages.ts`).
 */

import type { Language } from "../catalog";

/** Under "Get ready", in the middle of the arena. */
export function readySubtitle(language: Language): string {
    return language === "es"
        ? "&fRefúgiate de la lluvia: el último en pie gana"
        : "&fKeep out of the rain: the last one standing wins";
}

/** Under "Go!", as the rain starts and the cobblestone is handed out. */
export function goTitle(language: Language): string {
    return language === "es" ? "&a¡Lluvia ácida!" : "&aAcid rain!";
}

export function goSubtitle(language: Language): string {
    return language === "es"
        ? "&fConstruye un techo: la lluvia lo va comiendo"
        : "&fBuild a roof: the rain eats it away";
}

/** Above the hotbar of everybody still in: their acid, and who is left. */
export function bar(gauge: string, left: number, language: Language): string {
    return language === "es"
        ? `&eÁcido: ${gauge} &7| &f${left} &een pie`
        : `&eAcid: ${gauge} &7| &f${left} &estanding`;
}

/** Told when more cobblestone is handed out. */
export function topUp(count: number, language: Language): string {
    return language === "es"
        ? `&a+${count} de piedra para tu refugio.`
        : `&a+${count} cobblestone for your shelter.`;
}

/** Said to everybody when a player's acid bar fills. */
export function dissolved(name: string, left: number, language: Language): string {
    return language === "es"
        ? `&c${name} &cno aguantó la lluvia. &7Quedan &f${left}&7.`
        : `&c${name} &ccould not take the rain. &f${left} &7left.`;
}

/** Said when the server cannot play it at all: the data pack that works out
 *  who is in the rain could not be put on. */
export function cannotPlay(language: Language): string {
    return language === "es"
        ? "&cNo se puede jugar la lluvia ácida en este servidor ahora: &fno se juega esta vez."
        : "&cThe acid rain cannot be played on this server right now: &fnot this time.";
}
