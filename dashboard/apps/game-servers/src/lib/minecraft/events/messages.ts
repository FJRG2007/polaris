/**
 * What the players read during an event, in the language the server chose.
 *
 * Written with `&` colour codes, which the announcement writer turns into the
 * game's own formatting (`javaComponent`). No braces anywhere: `{player}` and its
 * kind are game variables to that writer, and a line must never ask for one by
 * accident.
 */

import type { EventKind, Language } from "./catalog";

type Text = Readonly<Record<Language, string>>;

const pick = (text: Text, language: Language): string => text[language];

/** An event's kind in the players' words, for titles. */
const KIND_NAMES: Readonly<Record<EventKind, Text>> = {
    "mining-rush": { en: "Mining rush", es: "Fiebre minera" },
    "mob-hunt": { en: "Mob hunt", es: "Cacería" },
    "supply-drop": { en: "Supply drop", es: "Suministro aéreo" },
    "blood-moon": { en: "Blood moon", es: "Luna de sangre" },
    "world-boss": { en: "World boss", es: "Jefe de mundo" },
    fishing: { en: "Fishing contest", es: "Concurso de pesca" },
    trivia: { en: "Trivia", es: "Trivia" },
    explorer: { en: "Explorer", es: "Explorador" },
    "happy-hour": { en: "Happy hour", es: "Hora feliz" },
    "king-of-the-hill": { en: "King of the hill", es: "Rey de la colina" }
};

/** What to do, in one line, said when the countdown starts and again at the start. */
const RULES: Readonly<Record<EventKind, Text>> = {
    "mining-rush": {
        en: "Mine as much ore as you can. Rarer ore is worth more.",
        es: "Pica toda la mena que puedas. La más rara vale más."
    },
    "mob-hunt": {
        en: "Kill hostile mobs. The dangerous ones are worth more.",
        es: "Mata mobs hostiles. Los más peligrosos valen más."
    },
    "supply-drop": {
        en: "A chest of loot is falling. The first to open it keeps it.",
        es: "Cae un cofre con botín. El primero en abrirlo se lo queda."
    },
    "blood-moon": {
        en: "Survive the night without dying. Kills put you on the podium.",
        es: "Sobrevive a la noche sin morir. Las muertes de mobs te suben al podio."
    },
    "world-boss": {
        en: "Bring the boss down together. Damage dealt near it counts.",
        es: "Derribad al jefe entre todos. Cuenta el daño hecho cerca de él."
    },
    fishing: {
        en: "Catch as much as you can with a fishing rod.",
        es: "Pesca todo lo que puedas con una caña."
    },
    trivia: {
        en: "Answer in the chat. The first right answer takes the round.",
        es: "Responde en el chat. La primera respuesta correcta gana la ronda."
    },
    explorer: {
        en: "Travel as far as you can - walking, swimming, riding or gliding.",
        es: "Recorre la mayor distancia posible: andando, nadando, montando o planeando."
    },
    "happy-hour": {
        en: "Enjoy the effects while they last.",
        es: "Disfruta de los efectos mientras duren."
    },
    "king-of-the-hill": {
        en: "Stay inside the circle. The longest time inside wins.",
        es: "Quédate dentro del círculo. Gana quien más tiempo pase dentro."
    }
};

export const TAG = "&6&l[Event]&r ";
const TAG_ES = "&6&l[Evento]&r ";

export function tag(language: Language): string {
    return language === "es" ? TAG_ES : TAG;
}

export function kindName(kind: EventKind, language: Language): string {
    return pick(KIND_NAMES[kind], language);
}

export function rules(kind: EventKind, language: Language, race = false): string {
    if (kind === "explorer" && race) {
        return language === "es"
            ? "Llega el primero a las coordenadas anunciadas."
            : "Be the first to reach the coordinates announced.";
    }
    return pick(RULES[kind], language);
}

export function startsIn(name: string, seconds: number, language: Language): string {
    const when = clock(seconds);
    return language === "es" ? `&e${name}&f empieza en &e${when}&f.` : `&e${name}&f starts in &e${when}&f.`;
}

export function startsSoonTitle(language: Language): string {
    return language === "es" ? "&6Se acerca un evento" : "&6An event is coming";
}

export function startedTitle(language: Language): string {
    return language === "es" ? "&a¡Empieza!" : "&aIt has begun!";
}

export function lasts(minutes: number, language: Language): string {
    return language === "es" ? `&7Dura ${minutes} min.` : `&7It lasts ${minutes} min.`;
}

/** `Mining rush - 4:32`, for the boss bar. */
export function barName(name: string, secondsLeft: number): string {
    return `${name} - ${clock(secondsLeft)}`;
}

export function startsInBar(name: string, secondsLeft: number, language: Language): string {
    return language === "es"
        ? `${name} empieza en ${clock(secondsLeft)}`
        : `${name} starts in ${clock(secondsLeft)}`;
}

/** m:ss, or h:mm:ss past an hour. */
export function clock(seconds: number): string {
    const total = Math.max(0, Math.ceil(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = String(total % 60).padStart(2, "0");
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

export function resultsHeader(name: string, language: Language): string {
    return language === "es" ? `&6&l${name}&r&6 - resultados` : `&6&l${name}&r&6 - results`;
}

const PLACES: Readonly<Record<Language, readonly string[]>> = {
    en: ["1st", "2nd", "3rd"],
    es: ["1.º", "2.º", "3.º"]
};

const PLACE_COLOURS = ["&6", "&7", "&c"];

export function podiumLine(place: number, name: string, score: string, language: Language): string {
    const label = PLACES[language][place - 1] ?? `${place}`;
    return `${PLACE_COLOURS[place - 1] ?? "&f"}${label} &f${name} &7- ${score}`;
}

export function winnerTitle(name: string, language: Language): string {
    return language === "es" ? `&6¡${name} gana!` : `&6${name} wins!`;
}

export function nobodyScored(language: Language): string {
    return language === "es" ? "&7Nadie puntuó esta vez." : "&7Nobody scored this time.";
}

export function endedTitle(language: Language): string {
    return language === "es" ? "&6Evento terminado" : "&6Event over";
}

export function cancelledLine(name: string, language: Language): string {
    return language === "es" ? `&7${name} se ha cancelado.` : `&7${name} was called off.`;
}

export function disqualifiedLine(names: readonly string[], language: Language): string {
    const list = names.join(", ");
    return language === "es"
        ? `&7Fuera del podio por el anti-cheat: &c${list}`
        : `&7Left off the podium by the anti-cheat: &c${list}`;
}

export function rewardGiven(event: string, language: Language): string {
    return language === "es"
        ? `&aHas recibido tu premio de &e${event}&a.`
        : `&aYou received your prize from &e${event}&a.`;
}

export function rewardWaiting(language: Language): string {
    return language === "es"
        ? "&7Quien no esté conectado recibirá su premio al volver."
        : "&7Anybody not online gets their prize when they come back.";
}

// ------------------------------------------------------------------ supply drop

export function dropArea(x: number, z: number, within: number, language: Language): string {
    return language === "es"
        ? `&eEl suministro ha caído cerca de &fX ${x}, Z ${z}&e (a menos de ${within} bloques).`
        : `&eThe supply drop landed near &fX ${x}, Z ${z}&e (within ${within} blocks).`;
}

export function dropExact(x: number, y: number, z: number, language: Language): string {
    return language === "es"
        ? `&eEl suministro está en &fX ${x} Y ${y} Z ${z}&e. Busca el haz de luz.`
        : `&eThe supply drop is at &fX ${x} Y ${y} Z ${z}&e. Look for the beam of light.`;
}

export function dropFound(name: string, language: Language): string {
    return language === "es" ? `&a${name} ha encontrado el suministro.` : `&a${name} found the supply drop.`;
}

export function dropLost(language: Language): string {
    return language === "es"
        ? "&7Nadie encontró el suministro y se ha perdido."
        : "&7Nobody found the supply drop, and it is gone.";
}

// ------------------------------------------------------------------ world boss

export function bossAppeared(boss: string, x: number, y: number, z: number, language: Language): string {
    return language === "es"
        ? `&c${boss}&f ha aparecido en &eX ${x} Y ${y} Z ${z}&f.`
        : `&c${boss}&f has appeared at &eX ${x} Y ${y} Z ${z}&f.`;
}

export function bossFell(boss: string, by: string | null, language: Language): string {
    if (language === "es") return by ? `&a${by} ha dado el golpe final a ${boss}.` : `&a${boss} ha caído.`;
    return by ? `&a${by} landed the final blow on ${boss}.` : `&a${boss} has fallen.`;
}

export function bossEscaped(boss: string, language: Language): string {
    return language === "es" ? `&7${boss} ha escapado.` : `&7${boss} got away.`;
}

// ------------------------------------------------------------------ blood moon

export function dawn(survivors: number, language: Language): string {
    return language === "es"
        ? `&eAmanece. Han sobrevivido &f${survivors}&e.`
        : `&eDawn breaks. &f${survivors}&e survived the night.`;
}

// ------------------------------------------------------------------ trivia

export function questionLine(round: number, rounds: number, question: string, language: Language): string {
    const label = language === "es" ? "Pregunta" : "Question";
    return `&b${label} ${round}/${rounds}: &f${question}`;
}

export function scrambleLine(round: number, rounds: number, word: string, language: Language): string {
    return language === "es"
        ? `&bRonda ${round}/${rounds}: &fordena la palabra &e${word}`
        : `&bRound ${round}/${rounds}: &funscramble &e${word}`;
}

export function roundWon(name: string, answer: string, language: Language): string {
    return language === "es"
        ? `&a${name} acertó: &f${answer}`
        : `&a${name} got it: &f${answer}`;
}

export function roundMissed(answer: string, language: Language): string {
    return language === "es" ? `&7Nadie acertó. Era &f${answer}` : `&7Nobody got it. It was &f${answer}`;
}

// ------------------------------------------------------------------ explorer, king of the hill

export function raceTarget(x: number, z: number, language: Language): string {
    return language === "es"
        ? `&eLa meta está en &fX ${x}, Z ${z}&e.`
        : `&eThe finish is at &fX ${x}, Z ${z}&e.`;
}

export function raceWon(name: string, language: Language): string {
    return language === "es" ? `&a${name} ha llegado el primero.` : `&a${name} got there first.`;
}

export function circleAt(x: number, y: number, z: number, language: Language): string {
    return language === "es"
        ? `&eEl círculo está en &fX ${x} Y ${y} Z ${z}&e.`
        : `&eThe circle is at &fX ${x} Y ${y} Z ${z}&e.`;
}

export function happyHourOver(language: Language): string {
    return language === "es" ? "&7La hora feliz ha terminado." : "&7Happy hour is over.";
}

/** A boss's name over its head. */
export function bossName(boss: string, language: Language): string {
    const names: Readonly<Record<string, Text>> = {
        "wither-skeleton": { en: "The Warlord", es: "El Señor de la Guerra" },
        ravager: { en: "The Juggernaut", es: "El Coloso" },
        vindicator: { en: "The Executioner", es: "El Verdugo" },
        husk: { en: "The Desert King", es: "El Rey del Desierto" }
    };
    return names[boss]?.[language] ?? boss;
}
