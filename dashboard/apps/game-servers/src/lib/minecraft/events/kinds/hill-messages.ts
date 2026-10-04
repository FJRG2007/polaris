/**
 * What the players read in a king of the hill played with fists only, in each
 * reader's language. Written with `&` colour codes, like the rest of the events'
 * lines (`../messages.ts`).
 */

import type { Language } from "../catalog";

export function enterTitle(language: Language): string {
    return language === "es" ? "&6Rey del ring" : "&6King of the ring";
}

export function enterSubtitle(language: Language): string {
    return language === "es"
        ? "&fSolo puños: echa a los demás del círculo"
        : "&fFists only: push the others out of the circle";
}

export function enterLine(language: Language): string {
    return language === "es"
        ? "&eTus cosas están guardadas y vuelven al acabar. Aquí nadie puede morir."
        : "&eYour things are kept safe and come back at the end. Nobody can die here.";
}

export function backOnHill(language: Language): string {
    return language === "es" ? "&eDe vuelta al ring" : "&eBack in the ring";
}

export function goTitle(language: Language): string {
    return language === "es" ? "&a¡Ya!" : "&aGo!";
}

export function goSubtitle(language: Language): string {
    return language === "es"
        ? "&fSolo cuenta el tiempo a solas en el ring"
        : "&fOnly time alone in the ring counts";
}

export function roundTitle(round: number, rounds: number, language: Language): string {
    return language === "es" ? `&6Ronda ${round}/${rounds}` : `&6Round ${round}/${rounds}`;
}

/** What the ring does this game, under each round's title. */
export function roundSubtitle(shrinks: boolean, moves: boolean, language: Language): string {
    const es = language === "es";
    if (shrinks && moves)
        return es ? "&fEl ring se encoge y se mueve" : "&fThe ring shrinks and moves";
    if (shrinks) return es ? "&fEl ring se encoge" : "&fThe ring shrinks";
    if (moves) return es ? "&fEl ring se mueve" : "&fThe ring moves";
    return es ? "&fEchadlos del ring" : "&fPush them out of the ring";
}

export function sprintTitle(language: Language): string {
    return language === "es" ? "&e¡Puntos dobles!" : "&eDouble points!";
}

export function sprintSubtitle(language: Language): string {
    return language === "es" ? "&fHasta el final de la ronda" : "&fUntil the round ends";
}

/** In the ring with somebody else: nobody scores until one is out. */
export function contested(language: Language): string {
    return language === "es"
        ? "&cRing disputado: &fecha a los demás para sumar"
        : "&cRing contested: &fpush the others out to score";
}

export function nextRound(language: Language): string {
    return language === "es" ? "&eSiguiente ronda..." : "&eNext round...";
}

/** Said in the chat when somebody new is ahead. */
export function leads(name: string, language: Language): string {
    return language === "es"
        ? `&b&l${name}&e lleva la corona: va primero`
        : `&b&l${name}&e wears the crown: in the lead`;
}
