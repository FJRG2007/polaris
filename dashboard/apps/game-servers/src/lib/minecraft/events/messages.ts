/**
 * What the players read during an event, in the language the server chose.
 *
 * Written with `&` color codes, which the announcement writer turns into the
 * game's own formatting (`javaComponent`). No braces anywhere: `{player}` and its
 * kind are game variables to that writer, and a line must never ask for one by
 * accident.
 */

import type { Heading } from "./commands";
import * as search from "./place-search";
import {
    itemName,
    KIND_NAMES,
    type EventKind,
    type GatherMaterial,
    type Language,
    type RareCatch
} from "./catalog";

type Text = Readonly<Record<Language, string>>;

const pick = (text: Text, language: Language): string => text[language];

/**
 * One palette for every line an event or a challenge says in the chat, so each
 * reads at a glance in a busy one: the tag in bold gold; a call-off, an
 * elimination or a refusal in red with the reason after it in white; a prize,
 * a win or a thing done in green; what to do next, a countdown or a warning in
 * yellow; the rest in gray. The values a player looks for - names, numbers,
 * places, the event's name, what was won - stand out in bold aqua whatever the
 * line's color. Shared with the challenges (`challenges/messages`).
 */
export const PALETTE = {
    tag: "&6&l",
    bad: "&c",
    reason: "&f",
    good: "&a",
    warn: "&e",
    info: "&7",
    mark: "&b&l"
} as const;

/** A value picked out of a line, then the line's own color again (a color code
 *  also ends the bold, as the game reads it). */
export function mark(value: string | number, back: string): string {
    return `${PALETTE.mark}${value}${back}`;
}

const { bad: BAD, reason: REASON, good: GOOD, warn: WARN, info: INFO } = PALETTE;

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
    },
    "treasure-hunt": {
        en: "Chests are hidden around you. Follow the clues; whoever opens the most wins.",
        es: "Hay cofres escondidos a tu alrededor. Sigue las pistas; gana quien abra más."
    },
    gathering: {
        en: "Each round names a material: gather as much as you can. Rarer ones score more.",
        es: "Cada ronda pide un material: consigue todo lo que puedas. Los raros puntúan más."
    },
    "rare-catch": {
        en: "Fish for the treasure announced. The first to catch it wins, and keeps it.",
        es: "Pesca el tesoro anunciado. Gana quien lo saque primero, y se lo queda."
    },
    "xp-boost": {
        en: "Extra experience for every mob you kill and every ore you mine.",
        es: "Experiencia extra por cada mob que mates y cada mena que piques."
    },
    waves: {
        en: "Hold the marked point against every wave. Nothing is lost if you die.",
        es: "Defiende el punto marcado de cada oleada. Si mueres no pierdes nada."
    },
    "meteor-shower": {
        en: "Meteors of ore are falling. Mine them first: every block counts.",
        es: "Caen meteoritos de mena. Pícalos antes que nadie: cada bloque cuenta."
    },
    parkour: {
        en: "Fastest to the finish wins; a fall only sends you back to your checkpoint.",
        es: "Gana el más rápido en llegar a la meta; si caes, vuelves a tu último control."
    },
    spleef: {
        en: "Dig the snow from under the others; the last one standing wins.",
        es: "Rompe la nieve bajo los demás; gana el último en pie."
    },
    "team-duel": {
        en: "Two teams, the same sword and shield. Bring a rival low to score. Nothing of yours is lost, whatever happens.",
        es: "Dos equipos, la misma espada y escudo. Deja a un rival sin vida para puntuar. No pierdes nada tuyo pase lo que pase."
    },
    "build-battle": {
        en: "Build the theme on your plot with the glass you are given - only it can be placed. Then vote for the best plot.",
        es: "Construye el tema en tu parcela con el cristal que recibes: solo ese se puede colocar. Luego vota la mejor parcela."
    },
    "tnt-run": {
        en: "The floor falls away right behind you. Keep running; the last one standing wins.",
        es: "El suelo desaparece justo detrás de ti. No dejes de correr; gana el último en pie."
    },
    "boat-race": {
        en: "Race your boat round the ice track through every gate. The first to finish the laps wins.",
        es: "Recorre en barco la pista de hielo pasando por cada puerta. Gana el primero en completar las vueltas."
    },
    dropper: {
        en: "Fall through the holes in every floor down to the water. Land on a floor and you start again from the top.",
        es: "Cae por los huecos de cada piso hasta el agua. Si aterrizas en un piso, vuelves arriba."
    },
    "capture-the-flag": {
        en: "Two teams. Take the other team's flag and carry it to yours. Brought low, you drop it. Nothing of yours is lost.",
        es: "Dos equipos. Coge la bandera rival y llévala a tu base. Si te dejan sin vida, la sueltas. No pierdes nada tuyo."
    },
    "hide-and-seek": {
        en: "Hide before the seekers are let go. A seeker's hit finds you, and then you seek too.",
        es: "Escóndete antes de que suelten a los buscadores. Si un buscador te golpea, te encuentra y pasas a buscar."
    },
    "hot-potato": {
        en: "Hit somebody to pass them the potato before it goes off. Holding it then, you are out; the last one left wins.",
        es: "Golpea a alguien para pasarle la patata antes de que explote. Si la tienes entonces, quedas fuera; gana el último."
    },
    "sky-wars": {
        en: "An island each. Loot your chests, bridge to the others and be the last one left. Nothing of yours is lost.",
        es: "Una isla para cada uno. Saquea tus cofres, tiende puentes hacia los demás y sé el último en pie. No pierdes nada tuyo."
    },
    "village-defense": {
        en: "Keep the villager alive through every wave. If it dies, nobody wins. Nothing is lost if you die.",
        es: "Mantén vivo al aldeano en cada oleada. Si muere, nadie gana. Si mueres no pierdes nada."
    },
    bingo: {
        en: "Get every item on the card into your inventory. Each one counts; the first full card wins.",
        es: "Consigue en tu inventario cada objeto del cartón. Cada uno cuenta; gana el primero en completarlo."
    },
    "boss-fishing": {
        en: "A legendary fish is on the line. Every catch wears it down; whoever caught the most when it is landed wins.",
        es: "Hay un pez legendario enganchado. Cada captura lo agota; gana quien más haya pescado cuando lo saquéis."
    }
};

export const TAG = `${PALETTE.tag}[Event]&r `;
const TAG_ES = `${PALETTE.tag}[Evento]&r `;

export function tag(language: Language): string {
    return language === "es" ? TAG_ES : TAG;
}

export function kindName(kind: EventKind, language: Language): string {
    return pick(KIND_NAMES[kind], language);
}

/** What decides an event and how it is played, when an option of it changes that. */
export interface RulesVariant {
    /** An explorer race rather than a distance. */
    readonly race?: boolean;
    /** A world boss in the sky arena, reached through a beam of light. */
    readonly arena?: boolean;
    /** A world boss won by the final blow rather than the most damage. */
    readonly finalBlow?: boolean;
    /** A horde defense won by damage dealt rather than kills. */
    readonly byDamage?: boolean;
    /** A king of the ring with fists only: time in it - alone, triple - in rounds. */
    readonly ring?: boolean;
    /** The ring's rounds, and whether it shrinks and moves over each. */
    readonly rounds?: number;
    readonly shrinks?: boolean;
    readonly moves?: boolean;
    /** A bingo won by its first full line rather than the whole card. */
    readonly line?: boolean;
}

export function rules(kind: EventKind, language: Language, variant: RulesVariant = {}): string {
    const es = language === "es";
    if (kind === "explorer" && variant.race) {
        return es
            ? "Llega el primero a las coordenadas anunciadas."
            : "Be the first to reach the coordinates announced.";
    }
    if (kind === "world-boss") {
        const goal = variant.finalBlow
            ? es
                ? "Derribad al jefe entre todos. Gana quien dé el golpe final."
                : "Bring the boss down together. The final blow wins."
            : es
              ? "Derribad al jefe entre todos. Gana quien más daño le haga."
              : "Bring the boss down together. The most damage wins.";
        if (!variant.arena) return goal;
        return `${goal} ${es ? "Camina hasta el haz de luz para subir a la arena." : "Walk into the beam of light to go up to the arena."}`;
    }
    if (kind === "king-of-the-hill" && variant.ring) {
        const hold = es
            ? "Aguanta en el ring: dentro sumas, y a solas, el triple."
            : "Hold the ring: in it you score, and alone, triple.";
        const end =
            (variant.rounds ?? 1) > 1
                ? es
                    ? "el final de cada ronda puntúa doble."
                    : "the end of each round counts double."
                : es
                  ? "el final puntúa doble."
                  : "the end counts double.";
        const does =
            variant.shrinks && variant.moves
                ? es
                    ? "Se encoge y se mueve"
                    : "It shrinks and moves"
                : variant.shrinks
                  ? es
                      ? "Se encoge"
                      : "It shrinks"
                  : variant.moves
                    ? es
                        ? "Se mueve"
                        : "It moves"
                    : null;
        const tail = does
            ? `${does}, ${es ? "y " : "and "}${end}`
            : `${end.charAt(0).toUpperCase()}${end.slice(1)}`;
        return `${hold} ${tail}`;
    }
    if (kind === "bingo" && variant.line) {
        return es
            ? "Consigue en tu inventario objetos del cartón. Cada uno cuenta; gana la primera línea completa."
            : "Get items on the card into your inventory. Each one counts; the first full line wins.";
    }
    if (kind === "waves" && variant.byDamage) {
        return es
            ? "Defiende el punto de cada oleada. Gana quien más daño haga. Si mueres no pierdes nada."
            : "Hold the point against every wave. The most damage wins. Nothing is lost if you die.";
    }
    return pick(RULES[kind], language);
}

export function startsIn(name: string, seconds: number, language: Language): string {
    const when = mark(clock(seconds), WARN);
    return language === "es"
        ? `${WARN}${mark(name, WARN)} empieza en ${when}.`
        : `${WARN}${mark(name, WARN)} starts in ${when}.`;
}

/** The countdown's one line: when it starts, and what to do - in white. */
export function startsInWithRules(
    name: string,
    seconds: number,
    rulesText: string,
    language: Language
): string {
    return `${startsIn(name, seconds, language)} ${REASON}${rulesText}`;
}

export function startsSoonTitle(language: Language): string {
    return language === "es" ? "&6Se acerca un evento" : "&6An event is coming";
}

export function startedTitle(language: Language): string {
    return language === "es" ? "&a¡Empieza!" : "&aIt has begun!";
}

/** The start's one line: the event's name, what to do, and how long it lasts. */
export function startLine(
    name: string,
    rulesText: string,
    minutes: number,
    language: Language
): string {
    return `${mark(name, WARN)}: ${REASON}${rulesText} ${lasts(minutes, language)}`;
}

export function lasts(minutes: number, language: Language): string {
    return language === "es"
        ? `${INFO}Dura ${mark(minutes, INFO)} min.`
        : `${INFO}It lasts ${mark(minutes, INFO)} min.`;
}

/** `Mining rush - 4:32`, for the boss bar. */
export function barName(name: string, secondsLeft: number): string {
    return `${name} - ${clock(secondsLeft)}`;
}

/** The bar while an arena is still going up, before its clock starts. */
export function arenaGettingReady(name: string, language: Language): string {
    return language === "es" ? `${name} - preparando` : `${name} - getting ready`;
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
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
        : `${minutes}:${rest}`;
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
    return `${PLACE_COLOURS[place - 1] ?? "&f"}&l${label} ${mark(name, INFO)} - ${score}`;
}

export function winnerTitle(name: string, language: Language): string {
    return language === "es" ? `&6¡${name} gana!` : `&6${name} wins!`;
}

export function nobodyScored(language: Language): string {
    return language === "es" ? `${INFO}Nadie puntuó esta vez.` : `${INFO}Nobody scored this time.`;
}

export function endedTitle(language: Language): string {
    return language === "es" ? "&6Evento terminado" : "&6Event over";
}

export function cancelledLine(name: string, language: Language, reason?: string): string {
    const why = reason ? cancelReason(reason, language) : null;
    const event = mark(name, BAD);
    if (language === "es")
        return `${BAD}${event} se ha cancelado${why ? `: ${REASON}${why}` : "."}`;
    return `${BAD}${event} was called off${why ? `: ${REASON}${why}` : "."}`;
}

/**
 * Why an event ended early, for the players: the sentence the history keeps,
 * in Spanish where it is one Polaris writes itself.
 */
export function cancelReason(note: string, language: Language): string {
    if (language !== "es") return note.endsWith(".") ? note : `${note}.`;
    const only = /^Only (\d+) joined; it needs (\d+)$/.exec(note);
    if (only) return `solo se apuntaron ${only[1]} y hacen falta ${only[2]}.`;
    const known: Readonly<Record<string, string>> = {
        "Called off": "lo ha cancelado un administrador.",
        "Everybody left in it was on the same team":
            "todos los que quedaban eran del mismo equipo.",
        "Fewer than two players joined": "se apuntaron menos de dos jugadores.",
        [search.NO_GROUND]: "no se encontró un sitio libre y seguro cerca de los jugadores.",
        [search.NO_AIR]: "no se encontró aire libre para montarlo cerca de los jugadores.",
        [search.NOBODY_IN_OVERWORLD]: "no hay nadie en el mundo normal cerca de quien montarlo.",
        "The server stopped during the event": "el servidor se paró durante el evento."
    };
    return known[note] ?? (note.endsWith(".") ? note : `${note}.`);
}

export function disqualifiedLine(names: readonly string[], language: Language): string {
    const list = names.join(", ");
    return language === "es"
        ? `${INFO}Fuera del podio (anti-cheat, creativo o AFK todo el evento): ${BAD}${list}`
        : `${INFO}Left off the podium (anti-cheat, creative, or AFK the whole time): ${BAD}${list}`;
}

export function rewardGiven(event: string, language: Language): string {
    return language === "es"
        ? `${GOOD}Has recibido tu premio de ${mark(event, GOOD)}.`
        : `${GOOD}You received your prize from ${mark(event, GOOD)}.`;
}

/** Part of a prize the inventory had no room for, dropped where they stand. */
export function droppedAtFeet(count: number, item: string, language: Language): string {
    return language === "es"
        ? `${WARN}Inventario lleno: ${mark(`${count} ${item}`, WARN)} han caído a tus pies. Recógelos antes de que desaparezcan.`
        : `${WARN}Inventory full: ${mark(`${count} ${item}`, WARN)} fell at your feet. Pick them up before they despawn.`;
}

export function mendedWith(
    count: number,
    points: number,
    rest: boolean,
    language: Language
): string {
    return language === "es"
        ? `${GOOD}Tu equipo con Reparación se ha reparado: ${mark(count, GOOD)} objeto(s) con ${mark(points, GOOD)} de experiencia.${rest ? " El resto va a tu barra." : ""}`
        : `${GOOD}Your Mending gear was repaired: ${mark(count, GOOD)} item(s) with ${mark(points, GOOD)} experience.${rest ? " The rest goes on your bar." : ""}`;
}

export function rewardWaiting(language: Language): string {
    return language === "es"
        ? `${INFO}Quien no esté conectado recibirá su premio al volver.`
        : `${INFO}Anybody not online gets their prize when they come back.`;
}

// ------------------------------------------------------------------ supply drop

export function dropArea(x: number, z: number, within: number, language: Language): string {
    return language === "es"
        ? `${WARN}El suministro ha caído cerca de ${mark(`X ${x}, Z ${z}`, WARN)} (a menos de ${within} bloques).`
        : `${WARN}The supply drop landed near ${mark(`X ${x}, Z ${z}`, WARN)} (within ${within} blocks).`;
}

export function dropExact(x: number, y: number, z: number, language: Language): string {
    return language === "es"
        ? `${WARN}El suministro está en ${mark(`X ${x} Y ${y} Z ${z}`, WARN)}. Busca el haz de luz.`
        : `${WARN}The supply drop is at ${mark(`X ${x} Y ${y} Z ${z}`, WARN)}. Look for the beam of light.`;
}

export function dropFound(name: string, language: Language): string {
    return language === "es"
        ? `${GOOD}${mark(name, GOOD)} ha encontrado el suministro.`
        : `${GOOD}${mark(name, GOOD)} found the supply drop.`;
}

export function dropLost(language: Language): string {
    return language === "es"
        ? `${INFO}Nadie encontró el suministro y se ha perdido.`
        : `${INFO}Nobody found the supply drop, and it is gone.`;
}

// ------------------------------------------------------------------ world boss

export function bossAppeared(
    boss: string,
    x: number,
    y: number,
    z: number,
    language: Language
): string {
    return language === "es"
        ? `${WARN}${mark(boss, WARN)} ha aparecido en ${mark(`X ${x} Y ${y} Z ${z}`, WARN)}.`
        : `${WARN}${mark(boss, WARN)} has appeared at ${mark(`X ${x} Y ${y} Z ${z}`, WARN)}.`;
}

export function bossFell(boss: string, by: string | null, language: Language): string {
    if (language === "es")
        return by
            ? `${GOOD}${mark(by, GOOD)} ha dado el golpe final a ${mark(boss, GOOD)}.`
            : `${GOOD}${mark(boss, GOOD)} ha caído.`;
    return by
        ? `${GOOD}${mark(by, GOOD)} landed the final blow on ${mark(boss, GOOD)}.`
        : `${GOOD}${mark(boss, GOOD)} has fallen.`;
}

export function bossEscaped(boss: string, language: Language): string {
    return language === "es"
        ? `${INFO}${mark(boss, INFO)} ha escapado.`
        : `${INFO}${mark(boss, INFO)} got away.`;
}

// ------------------------------------------------------------------ blood moon

export function dawn(survivors: number, language: Language): string {
    return language === "es"
        ? `${WARN}Amanece. Han sobrevivido ${mark(survivors, WARN)}.`
        : `${WARN}Dawn breaks. ${mark(survivors, WARN)} survived the night.`;
}

// ------------------------------------------------------------------ trivia

export function questionLine(
    round: number,
    rounds: number,
    question: string,
    language: Language
): string {
    const label = language === "es" ? "Pregunta" : "Question";
    return `${WARN}${label} ${mark(`${round}/${rounds}`, WARN)}: ${REASON}${question}`;
}

export function scrambleLine(
    round: number,
    rounds: number,
    word: string,
    language: Language
): string {
    return language === "es"
        ? `${WARN}Ronda ${mark(`${round}/${rounds}`, WARN)}: ordena la palabra ${mark(word, WARN)}`
        : `${WARN}Round ${mark(`${round}/${rounds}`, WARN)}: unscramble ${mark(word, WARN)}`;
}

/** The round, big in the middle of the screen as it is asked. */
export function roundTitle(round: number, rounds: number, language: Language): string {
    return language === "es" ? `&bPregunta ${round}/${rounds}` : `&bQuestion ${round}/${rounds}`;
}

/** Longest a question can be and still fit under the title; a longer one is
 *  left to the action bar, which is wider. */
export const SUBTITLE_MAX = 48;

/** What a round asks: a question, a word to unscramble, or whether a sentence
 *  is true or false. */
export type RoundKind = "question" | "scramble" | "truth";

/** The two words of a true-or-false round, ahead of the sentence. */
function truthLead(language: Language): string {
    return language === "es" ? "Verdadero o falso" : "True or false";
}

/** A true-or-false round in the chat: the sentence to judge. */
export function truthLine(
    round: number,
    rounds: number,
    statement: string,
    language: Language
): string {
    return `${WARN}${truthLead(language)} ${mark(`${round}/${rounds}`, WARN)}: ${REASON}${statement}`;
}

/** The line under a true-or-false round: a button for each, and the letters
 *  that answer as well as a click. */
export function truthButtonsText(language: Language): {
    lead: string;
    yes: { label: string; hover: string };
    no: { label: string; hover: string };
} {
    return language === "es"
        ? {
              lead: `${WARN}Pulsa o escribe ${mark("v", WARN)} o ${mark("f", WARN)}:`,
              // i18n-ignore: in-game button, both languages here (speech picks one)
              yes: { label: "[Verdadero]", hover: "Responder verdadero" },
              // i18n-ignore: in-game button, both languages here (speech picks one)
              no: { label: "[Falso]", hover: "Responder falso" }
          }
        : {
              lead: `${WARN}Click or type ${mark("t", WARN)} or ${mark("f", WARN)}:`,
              // i18n-ignore: in-game button, both languages here (speech picks one)
              yes: { label: "[True]", hover: "Answer true" },
              // i18n-ignore: in-game button, both languages here (speech picks one)
              no: { label: "[False]", hover: "Answer false" }
          };
}

/** Under the title: the question itself when it fits, or where to read it. */
export function roundSubtitle(asked: string, kind: RoundKind, language: Language): string {
    if (kind === "scramble")
        return language === "es" ? `&fOrdena: &e${asked}` : `&fUnscramble: &e${asked}`;
    if (kind === "truth" && asked.length <= SUBTITLE_MAX)
        return `&f${asked} &e(${language === "es" ? "v/f" : "t/f"})`;
    if (kind === "truth") return `&e${truthLead(language)}`;
    if (asked.length <= SUBTITLE_MAX) return `&f${asked}`;
    return language === "es"
        ? "&7La pregunta, sobre tu barra"
        : "&7The question is above your hotbar";
}

/** Above the hotbar for as long as the round is open, with the time left. */
export function roundBar(
    asked: string,
    kind: RoundKind,
    secondsLeft: number,
    language: Language
): string {
    const prompt =
        kind === "scramble"
            ? language === "es"
                ? `&fOrdena: &e${asked}`
                : `&fUnscramble: &e${asked}`
            : kind === "truth"
              ? `&e${truthLead(language)}: &f${asked}`
              : `&f${asked}`;
    const reply =
        kind === "truth"
            ? language === "es"
                ? "pulsa o escribe v/f"
                : "click or type t/f"
            : language === "es"
              ? "responde en el chat"
              : "answer in the chat";
    return `${prompt} &7- ${reply} (${Math.max(0, Math.ceil(secondsLeft))} s)`;
}

/** Who took the round, on screen as well as in the chat. */
export function roundWonTitle(name: string, language: Language): string {
    return language === "es" ? `&a${name} acierta` : `&a${name} got it`;
}

export function roundMissedTitle(language: Language): string {
    return language === "es" ? "&7Nadie acertó" : "&7Nobody got it";
}

export function roundWon(name: string, answer: string, language: Language): string {
    return language === "es"
        ? `${GOOD}${mark(name, GOOD)} acertó: ${REASON}${answer}`
        : `${GOOD}${mark(name, GOOD)} got it: ${REASON}${answer}`;
}

export function roundMissed(answer: string, language: Language): string {
    return language === "es"
        ? `${INFO}Nadie acertó. Era ${mark(answer, INFO)}`
        : `${INFO}Nobody got it. It was ${mark(answer, INFO)}`;
}

// ------------------------------------------------------------------ explorer, king of the hill

export function raceTarget(x: number, z: number, language: Language): string {
    return language === "es"
        ? `${WARN}La meta está en ${mark(`X ${x}, Z ${z}`, WARN)}.`
        : `${WARN}The finish is at ${mark(`X ${x}, Z ${z}`, WARN)}.`;
}

export function raceWon(name: string, language: Language): string {
    return language === "es"
        ? `${GOOD}${mark(name, GOOD)} ha llegado el primero.`
        : `${GOOD}${mark(name, GOOD)} got there first.`;
}

export function circleAt(x: number, y: number, z: number, language: Language): string {
    return language === "es"
        ? `${WARN}El círculo está en ${mark(`X ${x} Y ${y} Z ${z}`, WARN)}: busca la columna de luz. Tu barra de acción te dice hacia dónde ir.`
        : `${WARN}The circle is at ${mark(`X ${x} Y ${y} Z ${z}`, WARN)}: look for the column of light. Your action bar shows the way.`;
}

export const HEADING_ES: Readonly<Record<Heading, string>> = {
    north: "norte",
    "north-east": "noreste",
    east: "este",
    "south-east": "sureste",
    south: "sur",
    "south-west": "suroeste",
    west: "oeste",
    "north-west": "noroeste"
};

/** How far the circle is from a player, and which way. */
export function hillGuide(meters: number, heading: Heading, language: Language): string {
    return language === "es"
        ? `&eCírculo: &f${meters} m &eal &f${HEADING_ES[heading]}`
        : `&eCircle: &f${meters} m &e${heading}`;
}

export function hillInside(language: Language): string {
    return language === "es"
        ? "&aEstás en el círculo: aguanta"
        : "&aYou are in the circle - hold it";
}

/** How far the ring is from a player, and which way: the fists-only hill. */
export function ringGuide(meters: number, heading: Heading, language: Language): string {
    return language === "es"
        ? `&eRing: &f${meters} m &eal &f${HEADING_ES[heading]}`
        : `&eRing: &f${meters} m &e${heading}`;
}

export function ringInside(language: Language): string {
    return language === "es" ? "&aEstás en el ring: aguanta" : "&aYou are in the ring - hold it";
}

export function happyHourOver(language: Language): string {
    return language === "es" ? `${INFO}La hora feliz ha terminado.` : `${INFO}Happy hour is over.`;
}

// ------------------------------------------------------------------ horde defense

export function wavesPointAt(x: number, y: number, z: number, language: Language): string {
    return language === "es"
        ? `${WARN}El punto a defender está en ${mark(`X ${x} Y ${y} Z ${z}`, WARN)}: busca la columna de luz. La primera oleada llega cuando haya alguien allí.`
        : `${WARN}The point to hold is at ${mark(`X ${x} Y ${y} Z ${z}`, WARN)}: look for the column of light. The first wave comes once somebody is there.`;
}

export function wavesPointTitle(language: Language): string {
    return language === "es" ? "&cDefended el punto" : "&cHold the point";
}

/** How far the point is from a player, and which way. */
export function wavesGuide(meters: number, heading: Heading, language: Language): string {
    return language === "es"
        ? `&ePunto a defender: &f${meters} m &eal &f${HEADING_ES[heading]}`
        : `&ePoint to hold: &f${meters} m &e${heading}`;
}

export function waveTitle(wave: number, waves: number, language: Language): string {
    return language === "es" ? `&cOleada ${wave}/${waves}` : `&cWave ${wave}/${waves}`;
}

export function waveSubtitle(count: number, language: Language): string {
    return language === "es" ? `&f${count} monstruos` : `&f${count} monsters`;
}

/** At the point, while a wave is on. */
export function waveFighting(
    wave: number,
    waves: number,
    left: number,
    language: Language
): string {
    return language === "es"
        ? `&cOleada ${wave}/${waves}&f: quedan &c${left}`
        : `&cWave ${wave}/${waves}&f: &c${left}&f left`;
}

/** At the point, between two waves. */
export function waveComing(
    wave: number,
    waves: number,
    seconds: number,
    language: Language
): string {
    const when = clock(seconds);
    return language === "es"
        ? `&eOleada ${wave}/${waves} en &f${when}`
        : `&eWave ${wave}/${waves} in &f${when}`;
}

/** The next wave is due, and nobody is at the point to meet it. */
export function waveWaiting(wave: number, waves: number, language: Language): string {
    return language === "es"
        ? `&eOleada ${wave}/${waves}: esperando a que alguien llegue al punto`
        : `&eWave ${wave}/${waves}: waiting for somebody at the point`;
}

export function waveCleared(wave: number, language: Language): string {
    return language === "es"
        ? `${GOOD}Oleada ${mark(wave, GOOD)} superada`
        : `${GOOD}Wave ${mark(wave, GOOD)} cleared`;
}

export function waveOver(wave: number, language: Language): string {
    return language === "es"
        ? `${INFO}Se acabó el tiempo de la oleada ${mark(wave, INFO)}`
        : `${INFO}Wave ${mark(wave, INFO)} ran out of time`;
}

export function waveHeldBy(count: number, language: Language): string {
    return language === "es"
        ? `&f${count} ${count === 1 ? "defensor" : "defensores"} en el punto`
        : `&f${count} ${count === 1 ? "defender" : "defenders"} at the point`;
}

/** At the end: how far the defense got. */
export function wavesHeld(fought: number, waves: number, language: Language): string {
    return language === "es"
        ? `${WARN}Se han defendido ${mark(fought, WARN)} de ${mark(waves, WARN)} oleadas.`
        : `${WARN}${mark(fought, WARN)} of ${mark(waves, WARN)} waves were fought off.`;
}

// ------------------------------------------------------------------ meteor shower

export function meteorTitle(language: Language): string {
    return language === "es" ? "&6¡Ha caído un meteorito!" : "&6A meteor has fallen!";
}

export function meteorAt(
    x: number,
    y: number,
    z: number,
    blocks: number,
    language: Language
): string {
    return language === "es"
        ? `${WARN}Un meteorito de ${mark(blocks, WARN)} bloques de mena ha caído en ${mark(`X ${x} Y ${y} Z ${z}`, WARN)}. Busca el haz de luz.`
        : `${WARN}A meteor of ${mark(blocks, WARN)} ore blocks landed at ${mark(`X ${x} Y ${y} Z ${z}`, WARN)}. Look for the beam of light.`;
}

/** How far the latest meteor still unmined is from a player, and which way. */
export function meteorGuide(
    meters: number,
    heading: Heading,
    left: number,
    language: Language
): string {
    return language === "es"
        ? `&6Meteorito: &f${meters} m &eal &f${HEADING_ES[heading]}&e, quedan &f${left}&e bloques`
        : `&6Meteor: &f${meters} m &e${heading}&e, &f${left}&e blocks left`;
}

export function meteorWaiting(language: Language): string {
    return language === "es"
        ? "&7El próximo meteorito está en camino"
        : "&7The next meteor is on its way";
}

export function meteorMinedOut(language: Language): string {
    return language === "es"
        ? `${INFO}Un meteorito ha quedado vacío.`
        : `${INFO}A meteor has been mined out.`;
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

// ------------------------------------------------------------------ treasure hunt

export function huntHiding(language: Language): string {
    return language === "es"
        ? `${INFO}Escondiendo los tesoros...`
        : `${INFO}Hiding the treasures...`;
}

/** Once every chest is down: how many, and how to find them - the one line the
 *  hunt says before the first is opened. */
export function huntStart(count: number, language: Language): string {
    if (language === "es")
        return count === 1
            ? `${WARN}Hay ${mark(1, WARN)} tesoro escondido. Busca la columna de luz: tu barra de acción marca la distancia y la dirección.`
            : `${WARN}Hay ${mark(count, WARN)} tesoros escondidos. Busca las columnas de luz: tu barra de acción marca el más cercano.`;
    return count === 1
        ? `${WARN}${mark(1, WARN)} treasure is hidden. Look for the column of light: your action bar shows how far and which way.`
        : `${WARN}${mark(count, WARN)} treasures are hidden. Look for the columns of light: your action bar points to the nearest.`;
}

export function huntOpened(name: string, left: number, language: Language): string {
    const who = mark(name, GOOD);
    if (language === "es")
        return left > 0
            ? `${GOOD}${who} ha abierto un tesoro. ${INFO}Quedan ${mark(left, INFO)}.`
            : `${GOOD}${who} ha abierto el último tesoro.`;
    return left > 0
        ? `${GOOD}${who} opened a treasure. ${INFO}${mark(left, INFO)} left.`
        : `${GOOD}${who} opened the last treasure.`;
}

/** Above the hotbar all through the hunt: the nearest chest nobody has opened,
 *  how far and which way, and how many are left. */
export function huntGuide(
    meters: number,
    heading: Heading,
    left: number,
    total: number,
    language: Language
): string {
    return language === "es"
        ? `&eTesoro: &f${meters} m &eal &f${HEADING_ES[heading]} &7(${left}/${total})`
        : `&eTreasure: &f${meters} m &e${heading} &7(${left}/${total})`;
}

export function huntLeftBar(left: number, total: number, language: Language): string {
    return language === "es"
        ? `&eTesoros por abrir: &f${left} de ${total}`
        : `&eTreasures left: &f${left} of ${total}`;
}

export function huntUnfound(left: number, language: Language): string {
    if (language === "es")
        return left === 1
            ? `${INFO}Un tesoro se ha quedado sin encontrar.`
            : `${INFO}${mark(left, INFO)} tesoros se han quedado sin encontrar.`;
    return left === 1
        ? `${INFO}One treasure was never found.`
        : `${INFO}${mark(left, INFO)} treasures were never found.`;
}

// ------------------------------------------------------------------ gathering

const MATERIAL_NAMES: Readonly<Record<GatherMaterial, Text>> = {
    wheat: { en: "Wheat", es: "Trigo" },
    logs: { en: "Logs (any wood)", es: "Troncos (cualquier madera)" },
    cobblestone: { en: "Cobblestone", es: "Roca" },
    iron_ingot: { en: "Iron ingots", es: "Lingotes de hierro" },
    coal: { en: "Coal", es: "Carbón" },
    kelp: { en: "Kelp", es: "Algas" },
    bamboo: { en: "Bamboo", es: "Bambú" },
    sugar_cane: { en: "Sugar cane", es: "Caña de azúcar" },
    potato: { en: "Potatoes", es: "Patatas" },
    carrot: { en: "Carrots", es: "Zanahorias" },
    sand: { en: "Sand", es: "Arena" },
    pumpkin: { en: "Pumpkins", es: "Calabazas" }
};

export function materialName(material: GatherMaterial, language: Language): string {
    return pick(MATERIAL_NAMES[material], language);
}

export function gatherTarget(material: GatherMaterial, language: Language): string {
    return language === "es"
        ? `${WARN}A recoger: ${mark(materialName(material, language), WARN)}`
        : `${WARN}Gather: ${mark(materialName(material, language), WARN)}`;
}

/** A gathering's round starting, as a title. */
export function gatherRoundTitle(round: number, rounds: number, language: Language): string {
    return language === "es" ? `&6Ronda ${round}/${rounds}` : `&6Round ${round}/${rounds}`;
}

/** A gathering's round starting, in the chat: what, and what one is worth. */
export function gatherRoundLine(
    round: number,
    rounds: number,
    material: GatherMaterial,
    worth: number,
    language: Language
): string {
    const what = mark(materialName(material, language), WARN);
    if (language === "es")
        return `${WARN}Ronda ${mark(`${round}/${rounds}`, WARN)}: recoge ${what}. Cada uno vale ${mark(worth, WARN)} ${worth === 1 ? "punto" : "puntos"}.`;
    return `${WARN}Round ${mark(`${round}/${rounds}`, WARN)}: gather ${what}. Each is worth ${mark(worth, WARN)} ${worth === 1 ? "point" : "points"}.`;
}

/** The boss bar through a gathering: the round, its material and its clock. */
export function gatherRoundBar(
    round: number,
    rounds: number,
    material: GatherMaterial,
    secondsLeft: number,
    language: Language
): string {
    return language === "es"
        ? `Ronda ${round}/${rounds}: ${materialName(material, language)} - ${clock(secondsLeft)}`
        : `Round ${round}/${rounds}: ${materialName(material, language)} - ${clock(secondsLeft)}`;
}

/** Above the hotbar: what to gather and how much of it so far. */
export function gatherBar(material: GatherMaterial, count: number, language: Language): string {
    return language === "es"
        ? `&e${materialName(material, language)}: &f${count} &7recogidos`
        : `&e${materialName(material, language)}: &f${count} &7gathered`;
}

// ------------------------------------------------------------------ rare catch

const CATCH_NAMES: Readonly<Record<RareCatch | "any", Text>> = {
    name_tag: { en: "a name tag", es: "una etiqueta" },
    saddle: { en: "a saddle", es: "una silla de montar" },
    nautilus_shell: { en: "a nautilus shell", es: "un caparazón de nautilo" },
    enchanted_book: { en: "an enchanted book", es: "un libro encantado" },
    bow: { en: "a bow", es: "un arco" },
    any: {
        en: "any treasure: a name tag, saddle, nautilus shell, enchanted book or bow",
        es: "cualquier tesoro: etiqueta, silla, caparazón de nautilo, libro encantado o arco"
    }
};

export function catchName(treasure: RareCatch | "any", language: Language): string {
    return pick(CATCH_NAMES[treasure], language);
}

export function catchTarget(treasure: RareCatch | "any", language: Language): string {
    return language === "es"
        ? `${WARN}Hay que pescar ${mark(catchName(treasure, language), WARN)}`
        : `${WARN}Fish up ${mark(catchName(treasure, language), WARN)}`;
}

/** Above the hotbar while it lasts, so nobody forgets what they are after. */
export function catchBar(treasure: RareCatch | "any", language: Language): string {
    if (treasure === "any")
        return language === "es" ? "&ePesca: &fcualquier tesoro" : "&eFish up: &fany treasure";
    return language === "es"
        ? `&ePesca: &f${catchName(treasure, language)}`
        : `&eFish up: &f${catchName(treasure, language)}`;
}

export function catchWon(name: string, language: Language): string {
    return language === "es"
        ? `${GOOD}¡${mark(name, GOOD)} lo ha pescado!`
        : `${GOOD}${mark(name, GOOD)} fished it up!`;
}

export function catchMissed(language: Language): string {
    return language === "es"
        ? `${INFO}Nadie lo pescó a tiempo.`
        : `${INFO}Nobody fished it up in time.`;
}

// ------------------------------------------------------------------ experience boost

export function boostBar(perKill: number, perOre: number, language: Language): string {
    const parts =
        language === "es"
            ? [perKill > 0 && `+${perKill} por mob`, perOre > 0 && `+${perOre} por mena`]
            : [perKill > 0 && `+${perKill} a mob`, perOre > 0 && `+${perOre} an ore`];
    const label = language === "es" ? "Experiencia extra" : "Experience boost";
    return `&a${label}: &f${parts.filter(Boolean).join(", ")}`;
}

export function boostOver(language: Language): string {
    return language === "es"
        ? `${INFO}La experiencia extra ha terminado.`
        : `${INFO}The experience boost is over.`;
}

// ------------------------------------------------------------------ parkour, spleef

/** The side panel's title while players join. */
export function joinListTitle(name: string, count: number, language: Language): string {
    return language === "es"
        ? `&6&l${name} &7(${count} apuntados)`
        : `&6&l${name} &7(${count} joined)`;
}

/** The line with the buttons: what to press, and what each does. */
export function joinButtonsText(language: Language): {
    lead: string;
    join: { label: string; hover: string };
    leave: { label: string; hover: string };
} {
    return language === "es"
        ? {
              lead: `${WARN}Pulsa para participar (o escribe ${mark("unirse", WARN)}):`,
              // i18n-ignore: in-game button, both languages here (speech picks one)
              join: {
                  label: "[Unirse]",
                  hover: "Te llevamos al empezar y te devolvemos a donde estabas"
              },
              // i18n-ignore: in-game button, both languages here (speech picks one)
              leave: { label: "[Salir]", hover: "Retirarte del evento" }
          }
        : {
              lead: `${WARN}Click to take part (or type ${mark("join", WARN)}):`,
              // i18n-ignore: in-game button, both languages here (speech picks one)
              join: {
                  label: "[Join]",
                  hover: "You are taken there when it starts and brought back after"
              },
              // i18n-ignore: in-game button, both languages here (speech picks one)
              leave: { label: "[Leave]", hover: "Drop out of the event" }
          };
}

export function joinHint(language: Language): string {
    return language === "es"
        ? `${WARN}Escribe ${mark("unirse", WARN)} en el chat para participar. Te llevamos y te devolvemos a donde estabas.`
        : `${WARN}Type ${mark("join", WARN)} in the chat to take part. You are taken there and brought back to where you were.`;
}

export function joinedYou(language: Language): string {
    return language === "es"
        ? `${GOOD}Estás dentro. Te llevamos al empezar; escribe ${mark("salir", GOOD)} para retirarte.`
        : `${GOOD}You are in. You are taken there when it starts; type ${mark("leave", GOOD)} to drop out.`;
}

export function leftYou(language: Language): string {
    return language === "es" ? `${INFO}Te has retirado.` : `${INFO}You dropped out.`;
}

/** Above everybody's hotbar through the countdown. */
export function joinedBar(count: number, language: Language): string {
    return language === "es"
        ? `&e${count} apuntados &7- escribe &funirse&7 para participar`
        : `&e${count} joined &7- type &fjoin&7 to take part`;
}

export function notSurvival(language: Language): string {
    return language === "es"
        ? `${WARN}Cambia a supervivencia o aventura para participar.`
        : `${WARN}Switch to survival or adventure to take part.`;
}

export function tooLate(language: Language): string {
    return language === "es"
        ? `${INFO}Ya ha empezado. Apúntate en la próxima.`
        : `${INFO}It has already started. Join the next one.`;
}

export function notEnoughJoined(joined: number, needed: number, language: Language): string {
    return language === "es"
        ? `${BAD}Solo se apuntaron ${mark(joined, BAD)} y hacen falta ${mark(needed, BAD)}: ${REASON}no se juega esta vez.`
        : `${BAD}Only ${mark(joined, BAD)} joined and it needs ${mark(needed, BAD)}: ${REASON}not this time.`;
}

export function backWhereYouWere(language: Language): string {
    return language === "es"
        ? `${INFO}Has vuelto a donde estabas.`
        : `${INFO}You are back where you were.`;
}

export function goTitle(language: Language): string {
    return language === "es" ? "&a&l¡Ya!" : "&a&lGo!";
}

/** Above the hotbar of whoever is in while the rest are still brought in. */
export function waitingForAll(arrived: number, total: number, language: Language): string {
    return language === "es"
        ? `${WARN}Esperando a todos: ${mark(`${arrived}/${total}`, WARN)}`
        : `${WARN}Waiting for everybody: ${mark(`${arrived}/${total}`, WARN)}`;
}

/** Said when the wait ran out before everybody was in. */
export function startedWithout(names: readonly string[], language: Language): string {
    return language === "es"
        ? `${WARN}Empieza sin esperar más a: ${REASON}${names.join(", ")}`
        : `${WARN}Started without waiting longer for: ${REASON}${names.join(", ")}`;
}

/** Under the countdown's numbers. */
export function getReady(language: Language): string {
    return language === "es" ? "&fPrepárate" : "&fGet ready";
}

/** One second of the countdown before "Go!". */
export function countdownNumber(left: number): string {
    return `&e&l${left}`;
}

export function parkourSubtitle(language: Language): string {
    return language === "es" ? "&fLlega a la meta dorada" : "&fMake it to the golden finish";
}

export function parkourBar(
    checkpoint: number,
    checkpoints: number,
    jump: number,
    jumps: number,
    language: Language
): string {
    return language === "es"
        ? `&eControl &f${checkpoint}/${checkpoints} &7- &esalto &f${jump}/${jumps}`
        : `&eCheckpoint &f${checkpoint}/${checkpoints} &7- &ejump &f${jump}/${jumps}`;
}

export function checkpointTitle(
    checkpoint: number,
    checkpoints: number,
    language: Language
): string {
    return language === "es"
        ? `&aControl ${checkpoint}/${checkpoints}`
        : `&aCheckpoint ${checkpoint}/${checkpoints}`;
}

/** Seen past the next checkpoint without reaching it: part of the course skipped. */
export function noShortcut(language: Language): string {
    return language === "es"
        ? `${BAD}Sin atajos: ${REASON}de vuelta a tu último control.`
        : `${BAD}No shortcuts: ${REASON}back to your last checkpoint.`;
}

export function backToCheckpoint(language: Language): string {
    return language === "es"
        ? `${INFO}De vuelta a tu último control.`
        : `${INFO}Back to your last checkpoint.`;
}

export function finishedLine(
    name: string,
    time: string,
    place: number,
    language: Language
): string {
    return language === "es"
        ? `${GOOD}${mark(name, GOOD)} llega a la meta en ${mark(time, GOOD)} (puesto ${mark(place, GOOD)}).`
        : `${GOOD}${mark(name, GOOD)} reached the finish in ${mark(time, GOOD)} (place ${mark(place, GOOD)}).`;
}

export function finishedBar(time: string, language: Language): string {
    return language === "es"
        ? `&aMeta en ${time} &7- escribe &fsalir&7 para volver ya`
        : `&aFinished in ${time} &7- type &fleave&7 to go back now`;
}

export function everybodyDone(language: Language): string {
    return language === "es" ? `${WARN}Todos han terminado.` : `${WARN}Everybody is done.`;
}

export function spleefReadyTitle(language: Language): string {
    return language === "es" ? "&ePrepárate" : "&eGet ready";
}

export function spleefReadySubtitle(
    variant: "shovel" | "decay" | "snowballs",
    language: Language
): string {
    if (variant === "decay")
        return language === "es"
            ? "&fLa nieve que pisas desaparece: no te pares"
            : "&fThe snow you stand on vanishes: keep moving";
    if (variant === "snowballs")
        return language === "es"
            ? "&fLas bolas rompen la nieve que tocan"
            : "&fSnowballs break the snow they hit";
    return language === "es"
        ? "&fRompe la nieve bajo los demás"
        : "&fBreak the snow under the others";
}

export function spleefGo(variant: "shovel" | "decay" | "snowballs", language: Language): string {
    if (variant === "decay") return language === "es" ? "&a&l¡Corre!" : "&a&lRun!";
    if (variant === "snowballs") return language === "es" ? "&a&l¡Fuego!" : "&a&lThrow!";
    return language === "es" ? "&a&l¡A cavar!" : "&a&lDig!";
}

export function spleefOut(name: string, left: number, language: Language): string {
    return language === "es"
        ? `${BAD}${mark(name, BAD)} ha caído. ${INFO}Quedan ${mark(left, INFO)}.`
        : `${BAD}${mark(name, BAD)} is out. ${INFO}${mark(left, INFO)} left.`;
}

export function spleefOutTitle(language: Language): string {
    return language === "es" ? "&cHas caído" : "&cYou are out";
}

export function spleefBar(
    left: number,
    variant: "shovel" | "decay" | "snowballs",
    language: Language
): string {
    if (variant === "decay")
        return language === "es"
            ? `&eQuedan &f${left} &7- sigue moviéndote`
            : `&f${left} &eleft &7- keep moving`;
    return language === "es"
        ? `&eQuedan &f${left} &7- no te caigas al piso de abajo`
        : `&f${left} &eleft &7- do not drop to the floor below`;
}

export function lastStanding(name: string, language: Language): string {
    return language === "es"
        ? `${GOOD}${mark(name, GOOD)} es el último en pie.`
        : `${GOOD}${mark(name, GOOD)} is the last one standing.`;
}

export function nobodyStanding(language: Language): string {
    return language === "es" ? `${INFO}No queda nadie en pie.` : `${INFO}Nobody is left standing.`;
}

// ------------------------------------------------------------------ joining

export function joinedLine(name: string, count: number, language: Language): string {
    return language === "es"
        ? `${GOOD}${mark(name, GOOD)} se ha unido ${INFO}(${count})`
        : `${GOOD}${mark(name, GOOD)} is in ${INFO}(${count})`;
}

export function joinFull(language: Language): string {
    return language === "es"
        ? `${INFO}Ya está completo; te guardamos sitio en el próximo.`
        : `${INFO}It is full; there is room in the next one.`;
}

export function takenBack(language: Language): string {
    return language === "es"
        ? `${INFO}Estás de vuelta. El kit del evento se ha retirado; todo lo tuyo sigue igual.`
        : `${INFO}You are back. The event's kit was taken back; everything of yours is as it was.`;
}

/**
 * Kept out of an event because what they carry could not all be put away
 * safely: the items named when it was those, everything of theirs left where
 * it was.
 */
export function keptOut(
    why: "unread" | "untakeable" | "unsaved" | "unsettled",
    items: readonly string[],
    language: Language
): string {
    const list = items.slice(0, 3).map(itemName).join(", ");
    if (why === "untakeable" && list)
        return language === "es"
            ? `${WARN}Tu ${list} no se puede guardar a salvo: no entras en este. Guárdalo y únete al siguiente.`
            : `${WARN}Your ${list} can't be put away safely, so you're not in this one. Store it and join the next.`;
    return language === "es"
        ? `${WARN}Tus cosas no se pudieron guardar a salvo: no entras en este.`
        : `${WARN}Your things couldn't be put away safely, so you're not in this one.`;
}

// ------------------------------------------------------------------ team duel

export function teamName(side: number, language: Language): string {
    if (language === "es") return side === 0 ? "&cRojo" : "&9Azul";
    return side === 0 ? "&cRed" : "&9Blue";
}

export function duelEnterTitle(side: number, language: Language): string {
    return language === "es"
        ? `&lEquipo ${teamName(side, language)}`
        : `&l${teamName(side, language)} team`;
}

export function duelEnterSubtitle(hearts: number, language: Language): string {
    return language === "es"
        ? `&fA ${hearts} corazones vuelves a tu lado`
        : `&fAt ${hearts} hearts you are sent back`;
}

/** `Red 3 - 2 Blue - 4:10`, for the boss bar. */
export function duelBar(
    red: number,
    blue: number,
    secondsLeft: number,
    language: Language
): string {
    return `${teamName(0, language)} ${red} &f- &9${blue} ${teamName(1, language)} &f- ${clock(secondsLeft)}`;
}

export function duelStatus(side: number, eliminations: number, language: Language): string {
    return language === "es"
        ? `&lEquipo ${teamName(side, language)} &7- tus eliminaciones: &f${eliminations}`
        : `&l${teamName(side, language)} team &7- your eliminations: &f${eliminations}`;
}

export function duelDown(name: string, by: string | null, language: Language): string {
    const who = mark(name, BAD);
    if (language === "es")
        return by ? `${BAD}${who} cae ante ${REASON}${by}` : `${BAD}${who} ha caído`;
    return by ? `${BAD}${who} is out - ${REASON}${by}` : `${BAD}${who} is out`;
}

export function duelResult(red: number, blue: number, language: Language): string {
    const score = `${teamName(0, language)} ${red} &7- &9${blue} ${teamName(1, language)}`;
    if (red === blue) return language === "es" ? `${score}&7: empate` : `${score}&7: a draw`;
    const winner = teamName(red > blue ? 0 : 1, language);
    return language === "es" ? `${score}&7: gana ${winner}` : `${score}&7: ${winner}&7 team wins`;
}

// ------------------------------------------------------------------ build battle

export function themeTitle(language: Language): string {
    return language === "es" ? "&eEl tema es" : "&eThe theme is";
}

export function themeLine(theme: string, language: Language): string {
    return language === "es"
        ? `${WARN}Tema: ${mark(theme, WARN)}`
        : `${WARN}Theme: ${mark(theme, WARN)}`;
}

export function plotBar(
    theme: string,
    plot: number,
    secondsLeft: number,
    language: Language
): string {
    return language === "es"
        ? `&eTema: &f${theme} &7- parcela ${plot} - ${clock(secondsLeft)}`
        : `&eTheme: &f${theme} &7- plot ${plot} - ${clock(secondsLeft)}`;
}

export function voteTitle(language: Language): string {
    return language === "es" ? "&a¡A votar!" : "&aTime to vote!";
}

/** The [Done] button offered to each builder a while into the building. */
export function doneOffer(language: Language): {
    lead: string;
    done: { label: string; hover: string };
} {
    return language === "es"
        ? {
              lead: `${WARN}¿Has terminado tu construcción?`,
              // i18n-ignore: in-game button, both languages here (speech picks one)
              done: { label: "[Terminado]", hover: "Cuando todos terminen, empieza la votación" }
          }
        : {
              lead: `${WARN}Finished your build?`,
              // i18n-ignore: in-game button, both languages here (speech picks one)
              done: { label: "[Done]", hover: "When everybody is done, the vote starts" }
          };
}

/** Said to a builder who pressed [Done], with the way back. */
export function doneMarked(language: Language): {
    lead: string;
    undo: { label: string; hover: string };
} {
    return language === "es"
        ? {
              lead: `${GOOD}Marcado como terminado.`,
              // i18n-ignore: in-game button, both languages here (speech picks one)
              undo: { label: "[Seguir construyendo]", hover: "Quitar el terminado y seguir" }
          }
        : {
              lead: `${GOOD}Marked as done.`,
              // i18n-ignore: in-game button, both languages here (speech picks one)
              undo: { label: "[Undo]", hover: "Take it back and keep building" }
          };
}

/** Said to a builder who took [Done] back, before the button again. */
export function undoMarked(language: Language): string {
    return language === "es" ? `${INFO}Sigues construyendo.` : `${INFO}Back to building.`;
}

/** The side panel's title while builders mark themselves done. */
export function doneListTitle(done: number, total: number, language: Language): string {
    return language === "es" ? `&6&lTerminado: ${done}/${total}` : `&6&lDone: ${done}/${total}`;
}

/** Everybody still building is done: the vote comes early. */
export function allDone(language: Language): string {
    return language === "es"
        ? `${GOOD}Todos han terminado: empieza la votación.`
        : `${GOOD}Everybody is done: the vote starts now.`;
}

export function voteHow(language: Language): string {
    return language === "es"
        ? `${WARN}Escribe en el chat el ${mark("número", WARN)} de la mejor parcela, que no sea la tuya. Un voto cada uno.`
        : `${WARN}Type the ${mark("number", WARN)} of the best plot in the chat - not your own. One vote each.`;
}

export function voteBar(plot: number, secondsLeft: number, language: Language): string {
    return language === "es"
        ? `&eParcela ${plot} &7- vota con su número en el chat - ${clock(secondsLeft)}`
        : `&ePlot ${plot} &7- vote with its number in the chat - ${clock(secondsLeft)}`;
}

export function plotTitle(plot: number, language: Language): string {
    return language === "es" ? `&eParcela ${plot}` : `&ePlot ${plot}`;
}

export function voteCounted(plot: number, language: Language): string {
    return language === "es"
        ? `${GOOD}Voto para la parcela ${mark(plot, GOOD)} anotado.`
        : `${GOOD}Your vote for plot ${mark(plot, GOOD)} is in.`;
}

export function voteOwn(language: Language): string {
    return language === "es"
        ? `${BAD}No puedes votar tu propia parcela.`
        : `${BAD}You cannot vote for your own plot.`;
}

export function voteAgain(language: Language): string {
    return language === "es" ? `${BAD}Ya has votado.` : `${BAD}You have already voted.`;
}

export function voteNoPlot(plot: number, language: Language): string {
    return language === "es"
        ? `${BAD}No hay parcela ${mark(plot, BAD)}.`
        : `${BAD}There is no plot ${mark(plot, BAD)}.`;
}

/** What the round is built with, in the reader's language. */
export function materialLine(
    names: Readonly<Record<Language, string>>,
    language: Language
): string {
    return language === "es"
        ? `${WARN}Material: ${mark(names.es, WARN)}`
        : `${WARN}Material: ${mark(names.en, WARN)}`;
}

export function themeWas(theme: string, language: Language): string {
    return language === "es"
        ? `${INFO}El tema era ${mark(theme, INFO)}`
        : `${INFO}The theme was ${mark(theme, INFO)}`;
}
