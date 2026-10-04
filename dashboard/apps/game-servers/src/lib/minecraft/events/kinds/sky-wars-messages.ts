/**
 * What the players read in SkyWars, in each reader's language, in the shared
 * palette (`../messages.ts`).
 */

import type { Language } from "../catalog";
import { PALETTE, mark } from "../messages";

const { bad: BAD, good: GOOD, warn: WARN, info: INFO, reason: REASON } = PALETTE;

export function goTitle(language: Language): string {
    return language === "es" ? `${GOOD}¡Ya!` : `${GOOD}Go!`;
}

export function goSubtitle(language: Language): string {
    return language === "es"
        ? "&fSaquea tus cofres y tiende puentes"
        : "&fLoot your chests and start bridging";
}

export function enterTitle(language: Language): string {
    return language === "es" ? "&6SkyWars" : "&6SkyWars";
}

export function enterSubtitle(language: Language): string {
    return language === "es"
        ? "&fNadie salta a otra isla: hay que tender puentes"
        : "&fNo jump reaches another island: build a bridge";
}

/** Why somebody is out, in a line everybody reads. */
export function outLine(
    name: string,
    why: "low" | "fell" | "left" | "died" | "gone",
    by: string | null,
    left: number,
    language: Language
): string {
    const who = mark(name, BAD);
    const tail =
        language === "es"
            ? ` ${INFO}Quedan ${mark(left, INFO)}.`
            : ` ${INFO}${mark(left, INFO)} left.`;
    if (language === "es") {
        const how =
            why === "fell"
                ? "cae al vacío"
                : why === "left"
                  ? "sale del área de juego"
                  : why === "gone"
                    ? "se ha ido"
                    : "queda fuera";
        return `${BAD}${who} ${how}${by ? ` ${REASON}(${by})` : ""}${BAD}.${tail}`;
    }
    const how =
        why === "fell"
            ? "fell into the void"
            : why === "left"
              ? "left the play area"
              : why === "gone"
                ? "left the game"
                : "is out";
    return `${BAD}${who} ${how}${by ? ` ${REASON}(${by})` : ""}${BAD}.${tail}`;
}

export function outTitle(language: Language): string {
    return language === "es" ? `${BAD}Fuera` : `${BAD}You are out`;
}

export function outSubtitle(language: Language): string {
    return language === "es"
        ? "&fTus cosas están a salvo; mira el resto desde la grada"
        : "&fYour things are safe; watch the rest from the gallery";
}

export function aliveBar(left: number, kills: number, language: Language): string {
    return language === "es"
        ? `${WARN}Quedan ${left} ${INFO}- tus eliminaciones: &f${kills}`
        : `${WARN}${left} left ${INFO}- your eliminations: &f${kills}`;
}

export function galleryBar(language: Language): string {
    return language === "es"
        ? `${INFO}Estás fuera: mira desde la grada`
        : `${INFO}You are out: watching from the gallery`;
}

/** The boss bar: who is left, and the time. */
export function bar(left: number, clock: string, language: Language): string {
    return language === "es" ? `&6Quedan ${left} &7- &f${clock}` : `&6${left} left &7- &f${clock}`;
}

export function winner(name: string, language: Language): string {
    return language === "es"
        ? `${GOOD}${mark(name, GOOD)} es el último en pie y gana.`
        : `${GOOD}${mark(name, GOOD)} is the last one standing and wins.`;
}

/** Why it ended before its time. */
export const LAST_ONE = "Only one player was left";
