/**
 * What the players read during a world boss fight, in each reader's language.
 *
 * Written with `&` color codes, never braces, like the rest of the events'
 * lines (`../messages.ts`).
 */

import type { Ability } from "./boss";
import type { BossDifficulty, BossKind, BossWinner, Language } from "../catalog";

type Text = Readonly<Record<Language, string>>;

const NAMES: Readonly<Record<BossKind, Text>> = {
    "wither-skeleton": { en: "The Warlord", es: "El Señor de la Guerra" },
    ravager: { en: "The Juggernaut", es: "El Coloso" },
    vindicator: { en: "The Executioner", es: "El Verdugo" },
    husk: { en: "The Desert King", es: "El Rey del Desierto" },
    evoker: { en: "The Archmage", es: "El Archimago" },
    captain: { en: "The Captain", es: "El Capitán" },
    wither: { en: "The Blight", es: "La Plaga" }
};

const DIFFICULTIES: Readonly<Record<BossDifficulty, Text>> = {
    normal: { en: "Normal", es: "Normal" },
    hard: { en: "Hard", es: "Difícil" },
    epic: { en: "Epic", es: "Épico" }
};

/** A boss's name over its head. */
export function bossName(kind: BossKind, language: Language): string {
    return NAMES[kind][language];
}

export function difficultyName(difficulty: BossDifficulty, language: Language): string {
    return DIFFICULTIES[difficulty][language];
}

/** `The Warlord (Epic)`, for the bar. */
export function barTitle(kind: BossKind, difficulty: BossDifficulty, language: Language): string {
    return `${NAMES[kind][language]} (${DIFFICULTIES[difficulty][language]})`;
}

export function inArena(boss: string, x: number, y: number, z: number, language: Language): string {
    return language === "es"
        ? `&c${boss}&f espera en una arena en el cielo sobre &eX ${x} Y ${y} Z ${z}&f. Camina hasta el haz de luz y entra en él para subir.`
        : `&c${boss}&f awaits in a sky arena over &eX ${x} Y ${y} Z ${z}&f. Walk into the beam of light to go up.`;
}

/** The arena is ready and there is no beam to walk into: everybody is taken up. */
export function takenUp(boss: string, language: Language): string {
    return language === "es"
        ? `&c${boss}&f espera en una arena en el cielo. Te subimos ahora.`
        : `&c${boss}&f awaits in a sky arena. You are being taken up now.`;
}

/** The subtitle when everybody is taken up, under the boss's name. */
export function takenUpSubtitle(language: Language): string {
    return language === "es" ? "&eTe subimos a la arena" : "&eTaking you up to the arena";
}

/** The subtitle when the arena is ready, under the boss's name: where the beam up is. */
export function beamSubtitle(x: number, y: number, z: number, language: Language): string {
    return language === "es"
        ? `&eEntra en el haz de luz: &fX ${x} Y ${y} Z ${z}`
        : `&eWalk into the beam of light: &fX ${x} Y ${y} Z ${z}`;
}

/** Above the hotbar of everybody not up yet: how far the beam is, and an arrow
 *  pointing at it from where they look. */
export function beamGuide(meters: number, arrow: string, language: Language): string {
    return language === "es"
        ? `&eHaz de luz hacia el jefe: &f${meters} m &e${arrow}`
        : `&eBeam of light to the boss: &f${meters} m &e${arrow}`;
}

/** The same on the land, in any language: how far the boss is, and which way. */
export function bossGuide(boss: string, meters: number, arrow: string): string {
    return `&c${boss}&e: &f${meters} m &e${arrow}`;
}

/** Said again every few seconds to everybody not up yet. */
export function beamReminder(x: number, y: number, z: number, language: Language): string {
    return language === "es"
        ? `&eLa pelea es en el cielo. Entra en el haz de luz de &fX ${x} Y ${y} Z ${z}&e para subir.`
        : `&eThe fight is up in the sky. Walk into the beam of light at &fX ${x} Y ${y} Z ${z}&e to go up.`;
}

/** Above a fighter's hotbar: the damage they have dealt so far, before the score. */
export function yourDamage(language: Language): string {
    return language === "es" ? "Tu daño: " : "Your damage: ";
}

/** At the end: everybody's damage, most first. */
export function damageRanking(
    entries: readonly { name: string; damage: number }[],
    language: Language
): string {
    const list = entries
        .map((one, index) => `&f${index + 1}. &b${one.name} &f${one.damage}`)
        .join("&7, ");
    return language === "es" ? `&7Daño hecho: ${list}` : `&7Damage dealt: ${list}`;
}

export function enteredTitle(language: Language): string {
    return language === "es" ? "&c&l¡A luchar!" : "&c&lFight!";
}

export function leftArena(language: Language): string {
    return language === "es"
        ? "&7Has salido de la arena. El haz de luz te vuelve a subir."
        : "&7You left the arena. The beam of light takes you back up.";
}

/** The same when there is no beam to go back up by. */
export function leftArenaForGood(language: Language): string {
    return language === "es" ? "&7Has salido de la arena." : "&7You left the arena.";
}

export function phaseTitle(phase: 2 | 3, language: Language): string {
    if (phase === 2) return language === "es" ? "&5&lFase 2" : "&5&lPhase 2";
    return language === "es" ? "&4&l¡Furia!" : "&4&lRage!";
}

export function phaseSubtitle(phase: 2 | 3, language: Language): string {
    if (phase === 2)
        return language === "es"
            ? "&dMata a los esbirros para romper el escudo"
            : "&dKill the minions to break the shield";
    return language === "es"
        ? "&cGolpea más fuerte y ataca más a menudo"
        : "&cIt hits harder and attacks more often";
}

export function shieldUp(boss: string, language: Language): string {
    return language === "es"
        ? `&d${boss} se protege con un escudo. Mata a los esbirros para romperlo.`
        : `&d${boss} is shielded. Kill the minions to break the shield.`;
}

export function shieldBroken(language: Language): string {
    return language === "es" ? "&a¡El escudo se ha roto!" : "&aThe shield is broken!";
}

export function rageLine(boss: string, language: Language): string {
    return language === "es" ? `&4${boss} entra en furia.` : `&4${boss} flies into a rage.`;
}

export function warning(ability: Ability, arena: boolean, language: Language): string {
    switch (ability) {
        case "shockwave":
            return language === "es"
                ? "&c¡Onda expansiva! Aléjate"
                : "&cShockwave! Get away from it";
        case "leap":
            return language === "es" ? "&c¡Va a por ti!" : "&cIt is coming for you!";
        case "pull":
            return language === "es" ? "&5¡Te atrae hacia él!" : "&5It is pulling you in!";
        case "burst":
            if (arena) return language === "es" ? "&5¡Colmillos! Muévete" : "&5Fangs! Move!";
            return language === "es" ? "&5¡Vexes!" : "&5Vexes!";
    }
}

export function healing(boss: string, language: Language): string {
    return language === "es"
        ? `&7Nadie lucha contra ${boss}: se está curando.`
        : `&7Nobody is fighting ${boss}: it is healing.`;
}

export function stronger(boss: string, fighters: number, language: Language): string {
    return language === "es"
        ? `&7${boss} se hace más fuerte: ${fighters} luchan contra él.`
        : `&7${boss} grows stronger: ${fighters} are fighting it.`;
}

export function trophyName(kind: BossKind, language: Language): string {
    return language === "es" ? `Trofeo: ${NAMES[kind].es}` : `Trophy: ${NAMES[kind].en}`;
}

export function trophyLore(
    difficulty: BossDifficulty,
    winner: BossWinner,
    language: Language
): string {
    if (winner === "final-blow")
        return language === "es"
            ? `Golpe final - ${DIFFICULTIES[difficulty].es}`
            : `Final blow - ${DIFFICULTIES[difficulty].en}`;
    return language === "es"
        ? `Más daño - ${DIFFICULTIES[difficulty].es}`
        : `Most damage - ${DIFFICULTIES[difficulty].en}`;
}

export function trophyGiven(winner: BossWinner, language: Language): string {
    if (winner === "final-blow")
        return language === "es"
            ? "&6Por el golpe final te llevas su trofeo."
            : "&6For the final blow you take its trophy.";
    return language === "es"
        ? "&6Por hacerle más daño que nadie te llevas su trofeo."
        : "&6For dealing it the most damage you take its trophy.";
}
