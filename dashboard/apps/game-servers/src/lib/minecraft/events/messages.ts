/**
 * What the players read during an event, in the language the server chose.
 *
 * Written with `&` colour codes, which the announcement writer turns into the
 * game's own formatting (`javaComponent`). No braces anywhere: `{player}` and its
 * kind are game variables to that writer, and a line must never ask for one by
 * accident.
 */

import type { Heading } from "./commands";
import type { EventKind, GatherMaterial, Language, RareCatch } from "./catalog";

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
    "king-of-the-hill": { en: "King of the hill", es: "Rey de la colina" },
    "treasure-hunt": { en: "Treasure hunt", es: "Búsqueda del tesoro" },
    gathering: { en: "Gathering", es: "Recolección" },
    "rare-catch": { en: "Rare catch", es: "Pesca rara" },
    "xp-boost": { en: "Experience boost", es: "Experiencia extra" },
    waves: { en: "Horde defence", es: "Oleadas" },
    "meteor-shower": { en: "Meteor shower", es: "Lluvia de meteoritos" },
    parkour: { en: "Parkour race", es: "Carrera de parkour" },
    spleef: { en: "Spleef", es: "El suelo es lava" },
    "team-duel": { en: "Team duel", es: "Duelo por equipos" },
    "build-battle": { en: "Build battle", es: "Construcción rápida" }
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
    },
    "treasure-hunt": {
        en: "Chests are hidden around you. Follow the clues; whoever opens the most wins.",
        es: "Hay cofres escondidos a tu alrededor. Sigue las pistas; gana quien abra más."
    },
    gathering: {
        en: "Gather as much of the material announced as you can. Only what you gather now counts.",
        es: "Consigue todo lo que puedas del material anunciado. Solo cuenta lo que recojas ahora."
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
        en: "Type join in the chat to take part. Fastest to the finish wins; a fall only sends you back to your checkpoint.",
        es: "Escribe unirse en el chat para participar. Gana el más rápido en llegar a la meta; si caes, vuelves a tu último control."
    },
    spleef: {
        en: "Type join in the chat to take part. Dig the snow from under the others; the last one standing wins.",
        es: "Escribe unirse en el chat para participar. Rompe la nieve bajo los demás; gana el último en pie."
    },
    "team-duel": {
        en: "Two teams, the same sword and shield. Bring a rival low to score. Nothing of yours is lost, whatever happens.",
        es: "Dos equipos, la misma espada y escudo. Deja a un rival sin vida para puntuar. No pierdes nada tuyo pase lo que pase."
    },
    "build-battle": {
        en: "Build the theme on your plot with the glass you are given - only it can be placed. Then vote for the best plot.",
        es: "Construye el tema en tu parcela con el cristal que recibes: solo ese se puede colocar. Luego vota la mejor parcela."
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
    return language === "es"
        ? `&e${name}&f empieza en &e${when}&f.`
        : `&e${name}&f starts in &e${when}&f.`;
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

export function cancelledLine(name: string, language: Language, reason?: string): string {
    const why = reason ? cancelReason(reason, language) : null;
    if (language === "es") return `&7${name} se ha cancelado${why ? `: &f${why}` : "."}`;
    return `&7${name} was called off${why ? `: &f${why}` : "."}`;
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
        "Fewer than two players joined": "se apuntaron menos de dos jugadores.",
        "No dry ground was found for it near the players":
            "no se encontró un sitio libre y seguro cerca de los jugadores.",
        "The server stopped during the event": "el servidor se paró durante el evento."
    };
    return known[note] ?? (note.endsWith(".") ? note : `${note}.`);
}

export function disqualifiedLine(names: readonly string[], language: Language): string {
    const list = names.join(", ");
    return language === "es"
        ? `&7Fuera del podio (anti-cheat, creativo o AFK todo el evento): &c${list}`
        : `&7Left off the podium (anti-cheat, creative, or AFK the whole time): &c${list}`;
}

export function rewardGiven(event: string, language: Language): string {
    return language === "es"
        ? `&aHas recibido tu premio de &e${event}&a.`
        : `&aYou received your prize from &e${event}&a.`;
}

/** Part of a prize the inventory had no room for, dropped where they stand. */
export function droppedAtFeet(count: number, item: string, language: Language): string {
    return language === "es"
        ? `&6Tu inventario estaba lleno: &e${count} ${item}&6 han caído a tus pies. Recógelos antes de que desaparezcan.`
        : `&6Your inventory was full: &e${count} ${item}&6 fell at your feet. Pick them up before they despawn.`;
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
    return language === "es"
        ? `&a${name} ha encontrado el suministro.`
        : `&a${name} found the supply drop.`;
}

export function dropLost(language: Language): string {
    return language === "es"
        ? "&7Nadie encontró el suministro y se ha perdido."
        : "&7Nobody found the supply drop, and it is gone.";
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
        ? `&c${boss}&f ha aparecido en &eX ${x} Y ${y} Z ${z}&f.`
        : `&c${boss}&f has appeared at &eX ${x} Y ${y} Z ${z}&f.`;
}

export function bossFell(boss: string, by: string | null, language: Language): string {
    if (language === "es")
        return by ? `&a${by} ha dado el golpe final a ${boss}.` : `&a${boss} ha caído.`;
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

export function questionLine(
    round: number,
    rounds: number,
    question: string,
    language: Language
): string {
    const label = language === "es" ? "Pregunta" : "Question";
    return `&b${label} ${round}/${rounds}: &f${question}`;
}

export function scrambleLine(
    round: number,
    rounds: number,
    word: string,
    language: Language
): string {
    return language === "es"
        ? `&bRonda ${round}/${rounds}: &fordena la palabra &e${word}`
        : `&bRound ${round}/${rounds}: &funscramble &e${word}`;
}

/** The round, big in the middle of the screen as it is asked. */
export function roundTitle(round: number, rounds: number, language: Language): string {
    return language === "es" ? `&bPregunta ${round}/${rounds}` : `&bQuestion ${round}/${rounds}`;
}

/** Longest a question can be and still fit under the title; a longer one is
 *  left to the action bar, which is wider. */
export const SUBTITLE_MAX = 48;

/** Under the title: the question itself when it fits, or where to read it. */
export function roundSubtitle(asked: string, scramble: boolean, language: Language): string {
    if (scramble) return language === "es" ? `&fOrdena: &e${asked}` : `&fUnscramble: &e${asked}`;
    if (asked.length <= SUBTITLE_MAX) return `&f${asked}`;
    return language === "es"
        ? "&7La pregunta, sobre tu barra"
        : "&7The question is above your hotbar";
}

/** Above the hotbar for as long as the round is open, with the time left. */
export function roundBar(
    asked: string,
    scramble: boolean,
    secondsLeft: number,
    language: Language
): string {
    const prompt = scramble
        ? language === "es"
            ? `&fOrdena: &e${asked}`
            : `&fUnscramble: &e${asked}`
        : `&f${asked}`;
    const reply = language === "es" ? "responde en el chat" : "answer in the chat";
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
    return language === "es" ? `&a${name} acertó: &f${answer}` : `&a${name} got it: &f${answer}`;
}

export function roundMissed(answer: string, language: Language): string {
    return language === "es"
        ? `&7Nadie acertó. Era &f${answer}`
        : `&7Nobody got it. It was &f${answer}`;
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
        ? `&eEl círculo está en &fX ${x} Y ${y} Z ${z}&e: busca la columna de luz. Tu barra de acción te dice hacia dónde ir.`
        : `&eThe circle is at &fX ${x} Y ${y} Z ${z}&e: look for the column of light. Your action bar shows the way.`;
}

const HEADING_ES: Readonly<Record<Heading, string>> = {
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
export function hillGuide(metres: number, heading: Heading, language: Language): string {
    return language === "es"
        ? `&eCírculo: &f${metres} m &eal &f${HEADING_ES[heading]}`
        : `&eCircle: &f${metres} m &e${heading}`;
}

export function hillInside(language: Language): string {
    return language === "es"
        ? "&aEstás en el círculo: aguanta"
        : "&aYou are in the circle - hold it";
}

export function happyHourOver(language: Language): string {
    return language === "es" ? "&7La hora feliz ha terminado." : "&7Happy hour is over.";
}

// ------------------------------------------------------------------ horde defence

export function wavesPointAt(x: number, y: number, z: number, language: Language): string {
    return language === "es"
        ? `&eEl punto a defender está en &fX ${x} Y ${y} Z ${z}&e: busca la columna de luz. La primera oleada llega cuando haya alguien allí.`
        : `&eThe point to hold is at &fX ${x} Y ${y} Z ${z}&e: look for the column of light. The first wave comes once somebody is there.`;
}

export function wavesPointTitle(language: Language): string {
    return language === "es" ? "&cDefended el punto" : "&cHold the point";
}

/** How far the point is from a player, and which way. */
export function wavesGuide(metres: number, heading: Heading, language: Language): string {
    return language === "es"
        ? `&ePunto a defender: &f${metres} m &eal &f${HEADING_ES[heading]}`
        : `&ePoint to hold: &f${metres} m &e${heading}`;
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
    return language === "es" ? `&aOleada ${wave} superada` : `&aWave ${wave} cleared`;
}

export function waveOver(wave: number, language: Language): string {
    return language === "es"
        ? `&7Se acabó el tiempo de la oleada ${wave}`
        : `&7Wave ${wave} ran out of time`;
}

export function waveHeldBy(count: number, language: Language): string {
    return language === "es"
        ? `&f${count} ${count === 1 ? "defensor" : "defensores"} en el punto`
        : `&f${count} ${count === 1 ? "defender" : "defenders"} at the point`;
}

/** At the end: how far the defence got. */
export function wavesHeld(fought: number, waves: number, language: Language): string {
    return language === "es"
        ? `&eSe han defendido &f${fought}&e de &f${waves}&e oleadas.`
        : `&e${fought} of ${waves} waves were fought off.`;
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
        ? `&eUn meteorito de &f${blocks}&e bloques de mena ha caído en &fX ${x} Y ${y} Z ${z}&e. Busca el haz de luz.`
        : `&eA meteor of &f${blocks}&e ore blocks landed at &fX ${x} Y ${y} Z ${z}&e. Look for the beam of light.`;
}

/** How far the latest meteor still unmined is from a player, and which way. */
export function meteorGuide(
    metres: number,
    heading: Heading,
    left: number,
    language: Language
): string {
    return language === "es"
        ? `&6Meteorito: &f${metres} m &eal &f${HEADING_ES[heading]}&e, quedan &f${left}&e bloques`
        : `&6Meteor: &f${metres} m &e${heading}&e, &f${left}&e blocks left`;
}

export function meteorWaiting(language: Language): string {
    return language === "es"
        ? "&7El próximo meteorito está en camino"
        : "&7The next meteor is on its way";
}

export function meteorMinedOut(language: Language): string {
    return language === "es"
        ? "&7Un meteorito ha quedado vacío."
        : "&7A meteor has been mined out.";
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
    return language === "es" ? "&7Escondiendo los tesoros..." : "&7Hiding the treasures...";
}

/** The first clue: how far and which way from where everybody was. */
export function huntClueFar(
    number: number,
    metres: number,
    heading: Heading,
    from: { x: number; z: number },
    language: Language
): string {
    return language === "es"
        ? `&eTesoro ${number}: &fa unos ${metres} m al ${HEADING_ES[heading]}&e de X ${from.x}, Z ${from.z}.`
        : `&eTreasure ${number}: &fabout ${metres} m ${heading}&e of X ${from.x}, Z ${from.z}.`;
}

export function huntClueArea(
    number: number,
    x: number,
    z: number,
    within: number,
    language: Language
): string {
    return language === "es"
        ? `&eTesoro ${number}: &fcerca de X ${x}, Z ${z}&e (a menos de ${within} bloques).`
        : `&eTreasure ${number}: &fnear X ${x}, Z ${z}&e (within ${within} blocks).`;
}

export function huntClueExact(
    number: number,
    x: number,
    y: number,
    z: number,
    language: Language
): string {
    return language === "es"
        ? `&eTesoro ${number}: &fX ${x} Y ${y} Z ${z}`
        : `&eTreasure ${number}: &fX ${x} Y ${y} Z ${z}`;
}

export function huntBeams(language: Language): string {
    return language === "es"
        ? "&eÚltimos minutos: los tesoros que quedan tienen un haz de luz."
        : "&eLast minutes: the treasures left are marked by a beam of light.";
}

export function huntOpened(name: string, left: number, language: Language): string {
    if (language === "es")
        return left > 0
            ? `&a${name} ha abierto un tesoro. &7Quedan ${left}.`
            : `&a${name} ha abierto el último tesoro.`;
    return left > 0
        ? `&a${name} opened a treasure. &7${left} left.`
        : `&a${name} opened the last treasure.`;
}

/** Above the hotbar when a chest is close: how far and which way. */
export function huntNear(metres: number, heading: Heading, language: Language): string {
    return language === "es"
        ? `&eTesoro cerca: &f${metres} m &eal &f${HEADING_ES[heading]}`
        : `&eTreasure nearby: &f${metres} m &e${heading}`;
}

export function huntLeftBar(left: number, total: number, language: Language): string {
    return language === "es"
        ? `&eTesoros por abrir: &f${left} de ${total}`
        : `&eTreasures left: &f${left} of ${total}`;
}

export function huntUnfound(left: number, language: Language): string {
    if (language === "es")
        return left === 1
            ? "&7Un tesoro se ha quedado sin encontrar."
            : `&7${left} tesoros se han quedado sin encontrar.`;
    return left === 1 ? "&7One treasure was never found." : `&7${left} treasures were never found.`;
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
        ? `&eA recoger: &f${materialName(material, language)}`
        : `&eGather: &f${materialName(material, language)}`;
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
        ? `&eHay que pescar &f${catchName(treasure, language)}`
        : `&eFish up &f${catchName(treasure, language)}`;
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
    return language === "es" ? `&a¡${name} lo ha pescado!` : `&a${name} fished it up!`;
}

export function catchMissed(language: Language): string {
    return language === "es" ? "&7Nadie lo pescó a tiempo." : "&7Nobody fished it up in time.";
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
        ? "&7La experiencia extra ha terminado."
        : "&7The experience boost is over.";
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
              lead: "&ePulsa para participar (o escribe &funirse&e):",
              join: { label: "[Unirse]", hover: "Te llevamos al empezar y te devolvemos a donde estabas" },
              leave: { label: "[Salir]", hover: "Retirarte del evento" }
          }
        : {
              lead: "&eClick to take part (or type &fjoin&e):",
              join: { label: "[Join]", hover: "You are taken there when it starts and brought back after" },
              leave: { label: "[Leave]", hover: "Drop out of the event" }
          };
}

export function joinHint(language: Language): string {
    return language === "es"
        ? "&eEscribe &funirse&e en el chat para participar. Te llevamos y te devolvemos a donde estabas."
        : "&eType &fjoin&e in the chat to take part. You are taken there and brought back to where you were.";
}

export function joinedYou(language: Language): string {
    return language === "es"
        ? "&aEstás dentro. Te llevamos al empezar; escribe &fsalir&a para retirarte."
        : "&aYou are in. You are taken there when it starts; type &fleave&a to drop out.";
}

export function leftYou(language: Language): string {
    return language === "es" ? "&7Te has retirado." : "&7You dropped out.";
}

/** Above everybody's hotbar through the countdown. */
export function joinedBar(count: number, language: Language): string {
    return language === "es"
        ? `&e${count} apuntados &7- escribe &funirse&7 para participar`
        : `&e${count} joined &7- type &fjoin&7 to take part`;
}

export function notSurvival(language: Language): string {
    return language === "es"
        ? "&7Cambia a supervivencia o aventura para participar."
        : "&7Switch to survival or adventure to take part.";
}

export function tooLate(language: Language): string {
    return language === "es"
        ? "&7Ya ha empezado. Apúntate en la próxima."
        : "&7It has already started. Join the next one.";
}

export function notEnoughJoined(joined: number, needed: number, language: Language): string {
    return language === "es"
        ? `&7Solo se apuntaron ${joined} y hacen falta ${needed}: no se juega esta vez.`
        : `&7Only ${joined} joined and it needs ${needed}: not this time.`;
}

export function backWhereYouWere(language: Language): string {
    return language === "es" ? "&7Has vuelto a donde estabas." : "&7You are back where you were.";
}

export function goTitle(language: Language): string {
    return language === "es" ? "&a&l¡Ya!" : "&a&lGo!";
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

export function backToCheckpoint(language: Language): string {
    return language === "es"
        ? "&7De vuelta a tu último control."
        : "&7Back to your last checkpoint.";
}

export function finishedLine(
    name: string,
    time: string,
    place: number,
    language: Language
): string {
    return language === "es"
        ? `&a${name} llega a la meta en &f${time}&a (puesto ${place}).`
        : `&a${name} reached the finish in &f${time}&a (place ${place}).`;
}

export function finishedBar(time: string, language: Language): string {
    return language === "es"
        ? `&aMeta en ${time} &7- escribe &fsalir&7 para volver ya`
        : `&aFinished in ${time} &7- type &fleave&7 to go back now`;
}

export function everybodyDone(language: Language): string {
    return language === "es" ? "&eTodos han terminado." : "&eEverybody is done.";
}

export function spleefReadyTitle(language: Language): string {
    return language === "es" ? "&ePrepárate" : "&eGet ready";
}

export function spleefReadySubtitle(language: Language): string {
    return language === "es"
        ? "&fRompe la nieve bajo los demás"
        : "&fBreak the snow under the others";
}

export function spleefGo(language: Language): string {
    return language === "es" ? "&a&l¡A cavar!" : "&a&lDig!";
}

export function spleefOut(name: string, left: number, language: Language): string {
    return language === "es"
        ? `&c${name} ha caído. &7Quedan ${left}.`
        : `&c${name} is out. &7${left} left.`;
}

export function spleefOutTitle(language: Language): string {
    return language === "es" ? "&cHas caído" : "&cYou are out";
}

export function spleefBar(left: number, language: Language): string {
    return language === "es"
        ? `&eQuedan &f${left} &7- no pises donde no hay nieve`
        : `&f${left} &eleft &7- stay on the snow`;
}

export function lastStanding(name: string, language: Language): string {
    return language === "es"
        ? `&a${name} es el último en pie.`
        : `&a${name} is the last one standing.`;
}

export function nobodyStanding(language: Language): string {
    return language === "es" ? "&7No queda nadie en pie." : "&7Nobody is left standing.";
}

// ------------------------------------------------------------------ joining

export function joinedLine(name: string, count: number, language: Language): string {
    return language === "es"
        ? `&a${name} se ha unido &7(${count})`
        : `&a${name} is in &7(${count})`;
}

export function joinFull(language: Language): string {
    return language === "es"
        ? "&7Ya está completo; te guardamos sitio en el próximo."
        : "&7It is full; there is room in the next one.";
}

export function takenBack(language: Language): string {
    return language === "es"
        ? "&7Estás de vuelta. El kit del evento se ha retirado; todo lo tuyo sigue igual."
        : "&7You are back. The event's kit was taken back; everything of yours is as it was.";
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
    if (language === "es") return by ? `&7${name} cae ante &f${by}` : `&7${name} ha caído`;
    return by ? `&7${name} is out - &f${by}` : `&7${name} is out`;
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
    return language === "es" ? `&eTema: &f${theme}` : `&eTheme: &f${theme}`;
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

export function voteHow(language: Language): string {
    return language === "es"
        ? "&fEscribe en el chat el número de la mejor parcela, que no sea la tuya. Un voto cada uno."
        : "&fType the number of the best plot in the chat - not your own. One vote each.";
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
        ? `&aVoto para la parcela ${plot} anotado.`
        : `&aYour vote for plot ${plot} is in.`;
}

export function voteOwn(language: Language): string {
    return language === "es"
        ? "&7No puedes votar tu propia parcela."
        : "&7You cannot vote for your own plot.";
}

export function voteAgain(language: Language): string {
    return language === "es" ? "&7Ya has votado." : "&7You have already voted.";
}

export function voteNoPlot(plot: number, language: Language): string {
    return language === "es" ? `&7No hay parcela ${plot}.` : `&7There is no plot ${plot}.`;
}

export function themeWas(theme: string, language: Language): string {
    return language === "es" ? `&7El tema era &f${theme}` : `&7The theme was &f${theme}`;
}
