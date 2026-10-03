/**
 * What the players read in a king of the hill played with fists only, in each
 * reader's language. Written with `&` colour codes, like the rest of the events'
 * lines (`../messages.ts`).
 */

import type { Language } from "../catalog";

export function enterTitle(language: Language): string {
    return language === "es" ? "&6Rey de la colina" : "&6King of the hill";
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
    return language === "es" ? "&eDe vuelta a la colina" : "&eBack on the hill";
}

/** Above the hotbar of whoever is in while the rest are still brought in. */
export function waitingForAll(arrived: number, total: number, language: Language): string {
    return language === "es"
        ? `&eEsperando a todos: &f${arrived}/${total}`
        : `&eWaiting for everybody: &f${arrived}/${total}`;
}

export function goTitle(language: Language): string {
    return language === "es" ? "&a¡Ya!" : "&aGo!";
}

export function goSubtitle(language: Language): string {
    return language === "es"
        ? "&fAguanta el círculo más que nadie"
        : "&fHold the circle longest to win";
}

/** Said when the wait ran out before everybody was on the platform. */
export function startedWithout(names: readonly string[], language: Language): string {
    return language === "es"
        ? `&eEmpieza sin esperar más a: &f${names.join(", ")}`
        : `&eStarted without waiting longer for: &f${names.join(", ")}`;
}
