/**
 * What the players read in Pillars, in each reader's language, in the shared
 * palette (`../messages.ts`).
 */

import type { Twist } from "./pillars";
import type { Language } from "../catalog";
import { PALETTE, mark } from "../messages";

const { bad: BAD, good: GOOD, warn: WARN, info: INFO, reason: REASON } = PALETTE;

export function goTitle(language: Language): string {
    return language === "es" ? `${GOOD}¡Ya!` : `${GOOD}Go!`;
}

export function goSubtitle(language: Language): string {
    return language === "es"
        ? "&fUn objeto cada pocos segundos: úsalo bien"
        : "&fAn item every few seconds: make it count";
}

/** Why somebody is out, in a line everybody reads. */
export function outLine(
    name: string,
    why: "fell" | "left" | "died" | "gone" | "void",
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
            ? why === "fell"
                ? "cae al vacío"
                : why === "void"
                  ? "es tragado por el vacío"
                  : why === "left"
                    ? "sale del área de juego"
                    : why === "gone"
                      ? "se ha ido"
                      : "queda fuera"
            : why === "fell"
              ? "fell into the void"
              : why === "void"
                ? "was swallowed by the void"
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
        ? "&fTus cosas están a salvo; mira desde arriba"
        : "&fYour things are safe; watch from above";
}

export function aliveBar(left: number, kills: number, language: Language): string {
    return language === "es"
        ? `${WARN}Quedan ${left} ${INFO}- eliminaciones: &f${kills}`
        : `${WARN}${left} left ${INFO}- eliminations: &f${kills}`;
}

export function galleryBar(language: Language): string {
    return language === "es"
        ? `${INFO}Estás fuera: mira desde arriba`
        : `${INFO}You are out: watching from above`;
}

/** The boss bar: who is left, the time, and the void once it rises. */
export function bar(left: number, clock: string, rising: boolean, language: Language): string {
    const head = language === "es" ? `&6Quedan ${left}` : `&6${left} left`;
    const rise = rising ? (language === "es" ? " &7- &cel vacío sube" : " &7- &cvoid rising") : "";
    return `${head} &7- &f${clock}${rise}`;
}

export function voidRising(language: Language): string {
    return language === "es"
        ? `${BAD}¡El vacío empieza a subir! Sube tú también.`
        : `${BAD}The void is rising! Climb or be swallowed.`;
}

export function twistLine(twist: Twist, language: Language): string {
    const es: Record<Twist, string> = {
        speed: "Velocidad para todos",
        jump: "Supersalto para todos",
        float: "Caída lenta para todos",
        lift: "¡Todos flotan un momento!",
        glow: "Todos brillan: nadie se esconde",
        bonus: "Objeto extra para todos"
    };
    const en: Record<Twist, string> = {
        speed: "Speed for everybody",
        jump: "Super jump for everybody",
        float: "Slow falling for everybody",
        lift: "Everybody floats for a moment!",
        glow: "Everybody glows: no hiding",
        bonus: "A bonus item for everybody"
    };
    return `${WARN}${language === "es" ? "Giro" : "Twist"}: &f${(language === "es" ? es : en)[twist]}`;
}

export function winner(name: string, language: Language): string {
    return language === "es"
        ? `${GOOD}${mark(name, GOOD)} es el último en pie y gana.`
        : `${GOOD}${mark(name, GOOD)} is the last one standing and wins.`;
}

/** Why it ended before its time. */
export const LAST_ONE = "Only one player was left";
