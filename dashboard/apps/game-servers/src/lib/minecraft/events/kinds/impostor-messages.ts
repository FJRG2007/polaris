/**
 * What the players read in an impostor game, in each reader's language, in the
 * shared palette (`../messages.ts`).
 */

import type { Language } from "../catalog";
import { PALETTE, mark } from "../messages";
import type { PlaceName, StationKind } from "./impostor";

const { bad: BAD, good: GOOD, warn: WARN, info: INFO } = PALETTE;

/** Why it ended, as the run's history keeps it. */
export const CREW_TASKS = "The crew finished every task";
export const CREW_VOTED = "Every impostor was voted out";
export const IMPOSTORS_OUTNUMBERED = "The impostors were as many as the crew";
export const IMPOSTORS_TIME = "The time ran out with an impostor aboard";

const ROOMS: Readonly<Record<PlaceName, Readonly<Record<Language, string>>>> = {
    meeting: { en: "Meeting room", es: "Sala de reuniones" },
    bridge: { en: "Bridge", es: "Puente de mando" },
    engine: { en: "Engine room", es: "Sala de motores" },
    greenhouse: { en: "Greenhouse", es: "Invernadero" },
    library: { en: "Library", es: "Biblioteca" },
    kitchen: { en: "Kitchen", es: "Cocina" },
    workshop: { en: "Workshop", es: "Taller" },
    observatory: { en: "Observatory", es: "Observatorio" },
    cargo: { en: "Cargo hold", es: "Bodega" },
    lab: { en: "Laboratory", es: "Laboratorio" },
    archive: { en: "Archive", es: "Archivo" },
    armory: { en: "Armory", es: "Armería" },
    infirmary: { en: "Infirmary", es: "Enfermería" },
    radio: { en: "Radio room", es: "Sala de radio" },
    cafeteria: { en: "Cafeteria", es: "Cafetería" },
    reactor: { en: "Reactor", es: "Reactor" },
    upperEngine: { en: "Upper engine", es: "Motor superior" },
    lowerEngine: { en: "Lower engine", es: "Motor inferior" },
    security: { en: "Security", es: "Seguridad" },
    medbay: { en: "MedBay", es: "Enfermería" },
    electrical: { en: "Electrical", es: "Electricidad" },
    admin: { en: "Admin", es: "Administración" },
    storage: { en: "Storage", es: "Almacén" },
    weapons: { en: "Weapons", es: "Armamento" },
    o2: { en: "O2", es: "Oxígeno" },
    navigation: { en: "Navigation", es: "Navegación" },
    shields: { en: "Shields", es: "Escudos" },
    communications: { en: "Communications", es: "Comunicaciones" }
};

const KINDS: Readonly<Record<StationKind, Readonly<Record<Language, string>>>> = {
    switch: { en: "flip the switch", es: "acciona la palanca" },
    button: { en: "press the button", es: "pulsa el botón" },
    scan: { en: "stand on the plate", es: "quédate en la placa" }
};

export function roomName(room: PlaceName, language: Language): string {
    return ROOMS[room][language];
}

/** One task: the room it is in and what kind of station it is. */
export interface Task {
    readonly room: Exclude<PlaceName, "meeting">;
    readonly kind: StationKind;
}

/** One task, as a list and a label read it: where, and what to do there. */
export function taskName(task: Task, language: Language): string {
    return `${ROOMS[task.room][language]}: ${KINDS[task.kind][language]}`;
}

export function crewTitle(language: Language): string {
    return language === "es" ? `${GOOD}Tripulación` : `${GOOD}Crew`;
}

export function crewSubtitle(impostors: number, language: Language): string {
    return language === "es"
        ? `&fHaz tus tareas. Hay ${impostors === 1 ? "un impostor" : `${impostors} impostores`} a bordo`
        : `&fDo your tasks. There ${impostors === 1 ? "is an impostor" : `are ${impostors} impostors`} aboard`;
}

export function impostorTitle(language: Language): string {
    return language === "es" ? `${BAD}Impostor` : `${BAD}Impostor`;
}

export function impostorSubtitle(language: Language): string {
    return language === "es"
        ? "&fElimina a la tripulación sin que te descubran"
        : "&fTake out the crew without being found out";
}

/** Told to each impostor alone: who else is one. */
export function partners(names: readonly string[], language: Language): string {
    const list = names.map((name) => mark(name, BAD)).join(", ");
    return language === "es"
        ? `${BAD}Los otros impostores: ${list}${BAD}.`
        : `${BAD}Your fellow impostors: ${list}${BAD}.`;
}

/** Told to each player alone at "Go!": their tasks - an impostor's to pretend with. */
export function taskList(tasks: readonly Task[], impostor: boolean, language: Language): string {
    const list = tasks.map((task) => taskName(task, language)).join(`${INFO}, &f`);
    if (impostor)
        return language === "es"
            ? `${INFO}Tareas para fingir (no cuentan): &f${list}`
            : `${INFO}Tasks to pretend with (they count for nothing): &f${list}`;
    return language === "es" ? `${GOOD}Tus tareas: &f${list}` : `${GOOD}Your tasks: &f${list}`;
}

/** Told to everybody at "Go!": how it is played. */
export function howTo(cooldown: number, language: Language): string {
    return language === "es"
        ? `${INFO}Un golpe de un impostor mata (cada ${cooldown} s). Clic derecho en un cuerpo, o escribe ${mark("reportar", INFO)} junto a él, para avisar; el botón de la mesa convoca una reunión.`
        : `${INFO}An impostor's hit kills (every ${cooldown}s). Right-click a body, or type ${mark("report", INFO)} beside it, to report it; the button on the table calls a meeting.`;
}

export function crewBar(
    done: number,
    total: number,
    next: Task | null,
    language: Language
): string {
    const left = next ? ` ${INFO}- &f${taskName(next, language)}` : "";
    return language === "es"
        ? `${GOOD}Tareas ${done}/${total}${left}`
        : `${GOOD}Tasks ${done}/${total}${left}`;
}

export function impostorBar(seconds: number, language: Language): string {
    if (seconds <= 0) return language === "es" ? `${BAD}Puedes matar` : `${BAD}Kill ready`;
    return language === "es"
        ? `${INFO}Podrás matar en ${Math.ceil(seconds)} s`
        : `${INFO}Kill ready in ${Math.ceil(seconds)}s`;
}

export function ghostBar(language: Language): string {
    return language === "es"
        ? `${INFO}Eres un fantasma: no hables con los vivos`
        : `${INFO}You are a ghost: say nothing to the living`;
}

export function scanBar(seconds: number, total: number, language: Language): string {
    return language === "es"
        ? `${WARN}Escaneando ${Math.min(total, Math.floor(seconds))}/${total} s`
        : `${WARN}Scanning ${Math.min(total, Math.floor(seconds))}/${total}s`;
}

/** The boss bar: the crew's tasks, and the time. */
export function bar(done: number, total: number, clock: string, language: Language): string {
    return language === "es"
        ? `&aTareas de la tripulación: ${done}/${total} &7- &f${clock}`
        : `&aCrew tasks: ${done}/${total} &7- &f${clock}`;
}

export function meetingBar(voting: boolean, seconds: number, language: Language): string {
    const left = Math.max(0, Math.ceil(seconds));
    if (voting) return language === "es" ? `${WARN}Votación: ${left} s` : `${WARN}Voting: ${left}s`;
    return language === "es" ? `${WARN}Debate: ${left} s` : `${WARN}Discussion: ${left}s`;
}

export function taskDone(task: Task, done: number, total: number, language: Language): string {
    return language === "es"
        ? `${GOOD}Hecho: &f${taskName(task, language)} ${INFO}(${done}/${total})`
        : `${GOOD}Done: &f${taskName(task, language)} ${INFO}(${done}/${total})`;
}

export function allTasksDone(language: Language): string {
    return language === "es"
        ? `${GOOD}Has hecho todas tus tareas.`
        : `${GOOD}You have done all your tasks.`;
}

export function killedTitle(language: Language): string {
    return language === "es" ? `${BAD}Te han matado` : `${BAD}You were killed`;
}

export function killedSubtitle(language: Language): string {
    return language === "es"
        ? "&fMira en silencio: no hables con los vivos"
        : "&fWatch in silence: say nothing to the living";
}

/** Told to a ghost: who they can still talk to. */
export function ghostTip(language: Language): string {
    return language === "es"
        ? `${INFO}Lo que escribas ahora solo lo leen los demás fantasmas, donde el servidor tiene Polaris; en cualquier otro, no escribas nada.`
        : `${INFO}What you type now reaches only the other ghosts, where the server has Polaris on it; on any other, type nothing.`;
}

export function killedLine(language: Language): string {
    return language === "es" ? `${BAD}Has matado.` : `${BAD}Kill made.`;
}

/** Said to whoever stands by a body nobody has reported, with a button. */
export function nearBody(language: Language): string {
    return language === "es" ? `${BAD}Hay un cuerpo aquí.` : `${BAD}There is a body here.`;
}

export function reportLabel(language: Language): string {
    return language === "es" ? "Reportar" : "Report";
}

export function reportedTitle(language: Language): string {
    return language === "es" ? `${BAD}¡Cuerpo encontrado!` : `${BAD}Body reported!`;
}

export function emergencyTitle(language: Language): string {
    return language === "es" ? `${WARN}¡Reunión de emergencia!` : `${WARN}Emergency meeting!`;
}

export function meetingSubtitle(by: string, language: Language): string {
    return language === "es" ? `&fLa convoca ${by}` : `&fCalled by ${by}`;
}

export function reported(by: string, body: string, language: Language): string {
    return language === "es"
        ? `${BAD}${mark(by, BAD)} ha encontrado el cuerpo de ${mark(body, BAD)}. ${INFO}Todos a la mesa.`
        : `${BAD}${mark(by, BAD)} found ${mark(body, BAD)}'s body. ${INFO}Everybody to the table.`;
}

export function emergency(by: string, language: Language): string {
    return language === "es"
        ? `${WARN}${mark(by, WARN)} ha pulsado el botón de emergencia. ${INFO}Todos a la mesa.`
        : `${WARN}${mark(by, WARN)} pressed the emergency button. ${INFO}Everybody to the table.`;
}

export function discuss(seconds: number, language: Language): string {
    return language === "es"
        ? `${INFO}Hablad: la votación se abre en ${seconds} s.`
        : `${INFO}Talk it over: the vote opens in ${seconds}s.`;
}

/** The first of a ballot's lines, for one player. */
export function ballotLead(seconds: number, language: Language): string {
    return language === "es"
        ? `${WARN}Vota en ${seconds} s: pulsa un nombre, o escribe ${mark("votar <nombre>", WARN)} o ${mark("saltar", WARN)}.`
        : `${WARN}Vote within ${seconds}s: click a name, or type ${mark("vote <name>", WARN)} or ${mark("skip", WARN)}.`;
}

export function skipLabel(language: Language): string {
    return language === "es" ? "Saltar" : "Skip";
}

export function voted(name: string, left: number, language: Language): string {
    return language === "es"
        ? `${INFO}${mark(name, INFO)} ha votado. Faltan ${left}.`
        : `${INFO}${mark(name, INFO)} has voted. ${left} to go.`;
}

export function noEmergencyLeft(language: Language): string {
    return language === "es"
        ? `${INFO}Ya no te quedan reuniones de emergencia.`
        : `${INFO}You have no emergency meetings left.`;
}

export function emergencyWait(seconds: number, language: Language): string {
    return language === "es"
        ? `${INFO}El botón se puede pulsar en ${Math.ceil(seconds)} s.`
        : `${INFO}The button can be pressed in ${Math.ceil(seconds)}s.`;
}

export function ejected(name: string, impostor: boolean | null, language: Language): string {
    const what =
        impostor === null
            ? ""
            : language === "es"
              ? impostor
                  ? ` ${BAD}Era un impostor.`
                  : ` ${GOOD}No era un impostor.`
              : impostor
                ? ` ${BAD}They were an impostor.`
                : ` ${GOOD}They were not an impostor.`;
    return language === "es"
        ? `${WARN}${mark(name, WARN)} ha sido expulsado.${what}`
        : `${WARN}${mark(name, WARN)} was voted out.${what}`;
}

export function ejectedTitle(language: Language): string {
    return language === "es" ? `${WARN}Te han expulsado` : `${WARN}You were voted out`;
}

export function nobodyEjected(skipped: boolean, language: Language): string {
    if (skipped)
        return language === "es"
            ? `${INFO}Se ha saltado la votación: nadie es expulsado.`
            : `${INFO}The vote was skipped: nobody is voted out.`;
    return language === "es"
        ? `${INFO}Empate: nadie es expulsado.`
        : `${INFO}A tie: nobody is voted out.`;
}

export function leftGame(name: string, language: Language): string {
    return language === "es"
        ? `${INFO}${mark(name, INFO)} ha dejado la partida.`
        : `${INFO}${mark(name, INFO)} left the game.`;
}

export function crewWon(why: "tasks" | "voted", language: Language): string {
    if (why === "tasks")
        return language === "es"
            ? `${GOOD}¡Gana la tripulación! Ha terminado todas sus tareas.`
            : `${GOOD}The crew wins! Every task is done.`;
    return language === "es"
        ? `${GOOD}¡Gana la tripulación! Ningún impostor queda a bordo.`
        : `${GOOD}The crew wins! No impostor is left aboard.`;
}

export function impostorsWon(why: "outnumbered" | "time", language: Language): string {
    if (why === "time")
        return language === "es"
            ? `${BAD}¡Ganan los impostores! Se acabó el tiempo.`
            : `${BAD}The impostors win! The time ran out.`;
    return language === "es"
        ? `${BAD}¡Ganan los impostores! Ya son tantos como la tripulación.`
        : `${BAD}The impostors win! They are as many as the crew.`;
}

export function impostorsWere(names: readonly string[], language: Language): string {
    const list = names.map((name) => mark(name, BAD)).join(", ");
    return language === "es"
        ? `${INFO}${names.length === 1 ? "El impostor era" : "Los impostores eran"}: ${list}${INFO}.`
        : `${INFO}The ${names.length === 1 ? "impostor was" : "impostors were"}: ${list}${INFO}.`;
}

/** Told to each player at "Go!", with the code that turns minimap radars off. */
export function radarOff(language: Language): string {
    return language === "es"
        ? `${INFO}Los radares del minimapa están apagados en esta partida.`
        : `${INFO}Minimap radars are switched off for this round.`;
}
