/**
 * What the players read in hide and seek, in each reader's language, in the
 * shared palette (`../messages.ts`).
 */

import type { Language } from "../catalog";
import { PALETTE, clock, mark } from "../messages";

const { bad: BAD, good: GOOD, warn: WARN, info: INFO } = PALETTE;

/** The two teams' names, as the game shows them: one for everybody. */
export function teamNames(language: Language): [string, string] {
    return language === "es" ? ["Buscadores", "Escondidos"] : ["Seekers", "Hiders"];
}

export function hideTitle(language: Language): string {
    return language === "es" ? `${GOOD}¡Escóndete!` : `${GOOD}Hide!`;
}

export function hideSubtitle(seconds: number, language: Language): string {
    return language === "es"
        ? `&fLos buscadores salen en ${seconds} s`
        : `&fThe seekers come out in ${seconds}s`;
}

export function seekTitle(language: Language): string {
    return language === "es" ? `${BAD}Te toca buscar` : `${BAD}You seek`;
}

export function seekSubtitle(seconds: number, language: Language): string {
    return language === "es"
        ? `&fEspera ${seconds} s; luego encuéntralos a golpes`
        : `&fWait ${seconds}s, then find them with a hit`;
}

export function releasedTitle(language: Language): string {
    return language === "es" ? `${BAD}¡Salen los buscadores!` : `${BAD}The seekers are out!`;
}

export function found(hider: string, by: string, left: number, language: Language): string {
    return language === "es"
        ? `${WARN}${mark(by, WARN)} encuentra a ${mark(hider, WARN)}. ${INFO}Quedan ${mark(left, INFO)} escondidos.`
        : `${WARN}${mark(by, WARN)} found ${mark(hider, WARN)}. ${INFO}${mark(left, INFO)} still hidden.`;
}

export function foundTitle(language: Language): string {
    return language === "es" ? `${WARN}Te han encontrado` : `${WARN}You were found`;
}

export function foundSubtitle(language: Language): string {
    return language === "es" ? "&fAhora buscas tú también" : "&fNow you seek too";
}

/**
 * A length of time as minutes and seconds in words ("1m 05s"), so a count up
 * is never read as the countdown on the boss bar ("1:05").
 */
function spell(seconds: number, language: Language): string {
    const total = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    if (minutes === 0) return language === "es" ? `${rest} s` : `${rest}s`;
    const padded = String(rest).padStart(2, "0");
    return language === "es" ? `${minutes} min ${padded} s` : `${minutes}m ${padded}s`;
}

/** A hider's action bar once the seekers are out: their score, named as one. */
export function hiddenBar(seconds: number, left: number, language: Language): string {
    return language === "es"
        ? `${GOOD}Tiempo escondido: ${spell(seconds, language)} ${INFO}- quedan ${left}`
        : `${GOOD}Time hidden: ${spell(seconds, language)} ${INFO}- ${left} still hidden`;
}

/** A hider's action bar while the seekers wait: the time left to hide, and
 *  how many hiders are ready (`ready` of `hiders`). */
export function hideBar(
    seconds: number,
    ready: number,
    hiders: number,
    language: Language
): string {
    return language === "es"
        ? `${GOOD}Tiempo para esconderte: ${INFO}${clock(seconds)} &7- ${WARN}Listos ${ready}/${hiders}`
        : `${GOOD}Time left to hide: ${INFO}${clock(seconds)} &7- ${WARN}Ready ${ready}/${hiders}`;
}

/** Offered to each hider as the hiding starts: once every hider is ready,
 *  the seekers come out at once. */
export function readyOffer(language: Language): {
    lead: string;
    ready: { label: string; hover: string };
} {
    return language === "es"
        ? {
              lead: `${WARN}¿Ya estás escondido?`,
              // i18n-ignore: in-game button, both languages here (speech picks one)
              ready: { label: "[Listo]", hover: "Cuando todos estén listos, salen los buscadores" }
          }
        : {
              lead: `${WARN}Hidden already?`,
              // i18n-ignore: in-game button, both languages here (speech picks one)
              ready: { label: "[Ready]", hover: "When every hider is ready, the seekers come out" }
          };
}

/** Said to a hider who pressed [Ready], with the way to take it back. */
export function readyMarked(language: Language): {
    lead: string;
    undo: { label: string; hover: string };
} {
    return language === "es"
        ? {
              lead: `${GOOD}Marcado como listo.`,
              // i18n-ignore: in-game button, both languages here (speech picks one)
              undo: { label: "[Aún no]", hover: "Quitar el listo y seguir escondiéndote" }
          }
        : {
              lead: `${GOOD}Marked as ready.`,
              // i18n-ignore: in-game button, both languages here (speech picks one)
              undo: { label: "[Not yet]", hover: "Take it back and keep hiding" }
          };
}

export function readyUndone(language: Language): string {
    return language === "es" ? `${INFO}Sigues escondiéndote.` : `${INFO}Back to hiding.`;
}

/** Every hider ready: the rest of the time to hide is skipped. */
export function allReady(language: Language): string {
    return language === "es"
        ? `${GOOD}Todos están escondidos: salen los buscadores.`
        : `${GOOD}Every hider is ready: the seekers are coming out.`;
}

/** A seeker's action bar while they wait: when they can start. */
export function waitBar(seconds: number, language: Language): string {
    return language === "es"
        ? `${BAD}Empiezas a buscar en ${INFO}${clock(seconds)}`
        : `${BAD}You can start seeking in ${INFO}${clock(seconds)}`;
}

export function seekBar(left: number, language: Language): string {
    return language === "es"
        ? `${BAD}Búscalos ${INFO}- quedan ${left} escondidos`
        : `${BAD}Find them ${INFO}- ${left} still hidden`;
}

/** The boss bar while the hiders hide: the same countdown for everybody. */
export function hidingBar(clockText: string, language: Language): string {
    return language === "es"
        ? `&aTiempo para esconderse: &f${clockText}`
        : `&aTime left to hide: &f${clockText}`;
}

/** The boss bar once the seekers are out: the time left in the game, and who is still hidden. */
export function bar(left: number, clockText: string, language: Language): string {
    return language === "es"
        ? `&aTiempo restante: &f${clockText} &7- &aEscondidos: ${left}`
        : `&aTime left: &f${clockText} &7- &aStill hidden: ${left}`;
}

/** Told to each player at "Go!", with the code that turns minimap radars off. */
export function radarOff(language: Language): string {
    return language === "es"
        ? `${INFO}Los radares del minimapa están apagados en esta partida.`
        : `${INFO}Minimap radars are switched off for this round.`;
}

/** Told at "Go!" in a house with secret rooms: where else to look. */
export function secretTip(language: Language): string {
    return language === "es"
        ? `${INFO}Hay estanterías que esconden una sala: pulsa su botón. Y mira hacia arriba.`
        : `${INFO}Some bookcases hide a room: press the button beside one. And look up.`;
}

/** Told at "Go!" in a manor (design 4 on): how its secrets open - from design
 *  5, the levers, the launch pads and the parkours (`climbs`). */
export function manorTip(language: Language, panels = true, climbs = false): string {
    if (climbs && panels)
        return language === "es"
            ? `${INFO}Las ${GOOD}palancas${INFO} abren paredes secretas (escucha el pistón), los bloques de ${GOOD}slime${INFO} te lanzan a una cornisa y los ${GOOD}postes${INFO} llevan saltando a un nido. Hay cuadros que son puertas. La lava quema a los buscadores.`
            : `${INFO}${GOOD}Levers${INFO} open secret walls (listen for the piston), ${GOOD}slime pads${INFO} launch you onto a ledge and the ${GOOD}posts${INFO} are a parkour up to a nest. Some paintings are doors. Lava burns seekers.`;
    if (climbs)
        return language === "es"
            ? `${INFO}Los ${GOOD}postes${INFO} llevan saltando a un nido, y hay cuadros que son puertas y huecos en paredes y suelos que llevan a escondites.`
            : `${INFO}The ${GOOD}posts${INFO} are a parkour up to a nest, and some paintings are doors and gaps in walls and floors lead to hiding places.`;
    if (!panels)
        return language === "es"
            ? `${INFO}Hay cuadros que son puertas, y huecos en paredes y suelos que llevan a escondites.`
            : `${INFO}Some paintings are doors, and gaps in walls and floors lead to hiding places.`;
    return language === "es"
        ? `${INFO}Hay cuadros que son puertas y paneles que se abren desde lejos: un botón, agacharte 3 veces en una alfombra, mirar arriba en una alfombra blanca o mirar fijo una calavera o una calabaza. La lava quema a los buscadores.`
        : `${INFO}Some paintings are doors, and panels open from across the room: a button, crouching 3 times on a rug, looking up from a white rug, or staring at a skull or a jack o'lantern. Lava burns seekers.`;
}

/** A hider's power-up, on their own action bar while it lasts. */
export function powerBar(power: "invisible" | "fast", seconds: number, language: Language): string {
    const left = Math.max(0, Math.ceil(seconds));
    if (language === "es")
        return `${GOOD}${power === "invisible" ? "Invisible" : "Veloz"} ${left} s`;
    return `${GOOD}${power === "invisible" ? "Invisible" : "Fast"} ${left}s`;
}

/** Said with the results. */
export function summary(found: number, hiders: number, language: Language): string {
    return language === "es"
        ? `${INFO}Encontrados ${mark(found, INFO)} de ${mark(hiders, INFO)}.`
        : `${INFO}${mark(found, INFO)} of ${mark(hiders, INFO)} found.`;
}

/** Why it ended before its time. */
export const ALL_FOUND = "Every hider was found";
