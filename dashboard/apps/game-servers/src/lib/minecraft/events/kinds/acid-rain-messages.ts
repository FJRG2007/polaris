/**
 * What the players read in an acid rain, in each reader's language. Written
 * with `&` colour codes, like the rest of the events' lines (`../messages.ts`).
 */

import type { Language } from "../catalog";
import type { Cover, Crate, Sky, Wind } from "./acid-rain";

/** Under "Get ready", in the middle of the arena. */
export function readySubtitle(language: Language): string {
    return language === "es"
        ? "&fQuédate a cubierto: gana el último en pie"
        : "&fStay under cover: the last one standing wins";
}

/** Under "Go!", as the rain starts and the cobblestone is handed out. */
export function goTitle(language: Language): string {
    return language === "es" ? "&a¡Lluvia ácida!" : "&aAcid rain!";
}

export function goSubtitle(language: Language): string {
    return language === "es"
        ? "&fQuédate a cubierto: la lluvia se come los techos"
        : "&fStay under cover - the rain eats roofs";
}

/** Told to everybody at "Go!": the whole game in one line. */
export function howItWorks(language: Language): string {
    return language === "es"
        ? "&fBajo la lluvia sube tu ácido; a 100 quedas fuera. &7La lluvia se come los techos: &frepáralos con tu piedra. &7Llega en oleadas: en cada &bcalma&7, corre a por los suministros que brillan. El último minuto, diluvio."
        : "&fOut in the rain your acid goes up; at 100 you are out. &7The rain eats roofs: &fpatch them with your cobblestone. &7It comes in waves: in each &bcalm&7, run for the glowing supplies. The last minute is a downpour.";
}

/** Where the wind comes from. */
export function windName(wind: Wind, language: Language): string {
    const names =
        language === "es"
            ? ["", "el norte", "el este", "el sur", "el oeste"]
            : ["", "the north", "the east", "the south", "the west"];
    return names[wind] ?? "";
}

/** What the sky is doing, as a name. */
export function skyName(sky: Sky, level: number, language: Language): string {
    if (language === "es")
        return {
            drizzle: "&aLlovizna",
            surge: `&c&lTormenta ${level}`,
            calm: "&b&lCalma",
            downpour: "&5&lDiluvio ácido"
        }[sky];
    return {
        drizzle: "&aDrizzle",
        surge: `&c&lSurge ${level}`,
        calm: "&b&lCalm",
        downpour: "&5&lAcid downpour"
    }[sky];
}

/** The boss bar: what the sky is doing, what comes next and when. */
export function skyBar(
    spell: { sky: Sky; level: number; wind: Wind },
    next: { sky: Sky; level: number } | null,
    clock: string,
    language: Language
): string {
    const name = skyName(spell.sky, spell.level, language);
    const wind =
        spell.wind > 0
            ? language === "es"
                ? ` &7| &fviento de ${windName(spell.wind, language)}`
                : ` &7| &fwind from ${windName(spell.wind, language)}`
            : "";
    if (!next)
        return language === "es"
            ? `${name}${wind} &7- aguanta &f${clock}`
            : `${name}${wind} &7- hold on &f${clock}`;
    const coming = skyName(next.sky, next.level, language).replace(/&l/g, "");
    return language === "es"
        ? `${name}${wind} &7- ${coming} &7en &f${clock}`
        : `${name}${wind} &7- ${coming} &7in &f${clock}`;
}

/** The title when the sky changes. */
export function skyTitle(sky: Sky, level: number, language: Language): string {
    return sky === "drizzle" ? " " : `${skyName(sky, level, language)}!`;
}

/** Under it: what to do now. */
export function skySubtitle(sky: Sky, wind: Wind, language: Language): string {
    const es = language === "es";
    if (wind > 0 && sky !== "calm")
        return es
            ? `&fViento de ${windName(wind, language)}: tapa también ese lado`
            : `&fWind from ${windName(wind, language)}: wall that side too`;
    switch (sky) {
        case "drizzle":
            return es ? "&aLlovizna: repara tu techo" : "&aDrizzle: patch your roof";
        case "surge":
            return es ? "&fMétete bajo techo" : "&fGet under a roof";
        case "calm":
            return es
                ? "&fCorre a por los suministros y reconstruye"
                : "&fRun for the supplies, then rebuild";
        case "downpour":
            return es ? "&fÚltimo minuto: aguanta" : "&fLast minute: hold on";
    }
}

/** Said to everybody at a calm: what the supplies are. */
export function calmLine(
    blocks: number,
    cure: number,
    umbrellaSeconds: number,
    language: Language
): string {
    return language === "es"
        ? `&b¡Calma! &fHan caído suministros: &6cofre &f+${blocks} bloques, &dleche &f-${cure} de ácido, &bescudo &f${umbrellaSeconds} s sin lluvia.`
        : `&bCalm! &fSupplies dropped: &6chest &f+${blocks} blocks, &dmilk &f-${cure} acid, &bshield &f${umbrellaSeconds} s rain-proof.`;
}

/** Said to everybody when a hut falls in. */
export function collapsed(language: Language): string {
    return language === "es" ? "&6¡Una choza se ha derrumbado!" : "&6A hut collapsed!";
}

/** Told to whoever picked a supply up. */
export function picked(crate: Crate, amount: number, language: Language): string {
    const es = language === "es";
    switch (crate) {
        case "blocks":
            return es ? `&6+${amount} de piedra.` : `&6+${amount} cobblestone.`;
        case "antidote":
            return es ? `&dAntídoto: -${amount} de ácido.` : `&dAntidote: -${amount} acid.`;
        case "umbrella":
            return es
                ? `&bParaguas: ${amount} s sin lluvia.`
                : `&bUmbrella: ${amount} s rain-proof.`;
    }
}

/** Above the hotbar of everybody still in: whether the rain is on them, their
 *  acid, and who is left. */
export function bar(
    cover: Cover,
    gauge: string,
    acid: number,
    umbrellaSeconds: number,
    left: number,
    language: Language
): string {
    const es = language === "es";
    const where =
        cover === "wet"
            ? es
                ? "&c&lBAJO LA LLUVIA"
                : "&c&lIN THE RAIN"
            : cover === "umbrella"
              ? es
                  ? `&b&lPARAGUAS ${umbrellaSeconds}s`
                  : `&b&lUMBRELLA ${umbrellaSeconds}s`
              : es
                ? "&a&lA CUBIERTO"
                : "&a&lCOVERED";
    return es
        ? `${where} &7| &eÁcido ${gauge} &f${acid} &7| &f${left} &een pie`
        : `${where} &7| &eAcid ${gauge} &f${acid} &7| &f${left} &estanding`;
}

/** The side panel's title: everybody's acid. */
export function sidebarTitle(language: Language): string {
    return language === "es" ? "&a&lÁcido &7(100 = fuera)" : "&a&lAcid &7(100 = out)";
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
