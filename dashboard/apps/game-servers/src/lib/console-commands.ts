/**
 * The commands an operator keeps beside the console.
 *
 * Every server has half a dozen lines somebody types over and over - the restart
 * warning, the day command, the one that saves the world before a settings change -
 * and typing them again each time is where the typo lands. So they are kept, and
 * kept on the server rather than in the browser: a saved command is a fact about
 * how this server is run, not about one person's laptop, and the second operator
 * of a server should inherit them rather than rediscover them. That is also the
 * difference from the history under the input box, which stays per browser
 * precisely because it is one person's typing.
 *
 * A command may carry a placeholder - `Broadcast <message>` - and that is what
 * decides whether pressing it runs it or loads it into the box. It may also carry
 * variables (`console-vars`), which the server fills in when it is run. Nothing
 * else about a saved command is interpreted: it is sent exactly as the console
 * would send it, through the same permission and the same audit line.
 *
 * A kept command may also be a sequence: several lines, read exactly as "Run
 * several" reads a block (`console-queue`) - `wait 10` pauses, `#` is a note -
 * and run one after another. It is stored the same way, its lines joined, so
 * every command kept before sequences existed is a sequence of one and runs as
 * it always did.
 *
 * Pure, so the dialog that validates a command as it is typed and the action that
 * stores it cannot disagree about what is allowed.
 */

import { gameMessage } from "./game-message";
import type { MinecraftEdition } from "./minecraft/service";
import { MAX_CONSOLE_LINE, commandCount, parseQueue, type QueueStep } from "./console-queue";
import {
    hasVariables,
    needsAsking,
    customVariablesProblem,
    normalizeCustomVariable,
    readCustomVariables,
    type CustomVariable
} from "./console-vars";

/** One line somebody kept. */
export interface SavedCommand {
    readonly id: string;
    /** What the button says. Never empty - it falls back to the command itself. */
    readonly label: string;
    readonly command: string;
    /** The values it asks for when it is run (`console-vars`). Absent when it
     *  declares none, which is every command kept before they existed. */
    readonly variables?: readonly CustomVariable[];
}

/** Where the list lives on the install's own settings blob. */
export const SAVED_COMMANDS_KEY = "consoleCommands";

/** Enough for a server run from a long list of its own commands. They are
 *  reached through a menu that is typed down to the one wanted, so the count is
 *  bounded by what the install's settings should carry, not by screen width. */
export const MAX_SAVED_COMMANDS = 100;

export const MAX_SAVED_LABEL = 40;

/** The same ceiling the console itself takes, so nothing can be saved that could
 *  not then be sent. */
export const MAX_SAVED_COMMAND = 400;

/** How many lines one kept sequence may hold, notes and pauses included. A
 *  sequence longer than this is a script, and the settings blob is no place for
 *  one. */
export const MAX_SAVED_LINES = 20;

/** The whole of a kept sequence, its lines joined. */
export const MAX_SAVED_SEQUENCE = 4000;

/** A blank to be filled in before sending: `Broadcast <message>`. */
const PLACEHOLDER = /<[^<>\n]*>/;

/** A command as it is typed: every line trimmed and the empty ones dropped. The
 *  one normalizer, on the screen and on the server. */
export function normalizeCommandText(text: string): string {
    return text
        .split(/\r?\n|\r/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join("\n");
}

/** Whether a kept command is several lines run one after another. */
export function isSequence(command: string): boolean {
    return command.includes("\n");
}

/** The steps a kept sequence runs, or null for a single command. Read the way
 *  "Run several" reads a block, so the two can never disagree. */
export function sequenceSteps(command: string): readonly QueueStep[] | null {
    if (!isSequence(command)) return null;
    const parsed = parseQueue(command, MAX_SAVED_COMMAND);
    return parsed.problem ? null : parsed.steps;
}

/** How many commands pressing it sends: one, or the commands of the sequence. */
export function keptCommandCount(command: string): number {
    const steps = sequenceSteps(command);
    return steps ? commandCount(steps) : 1;
}

/** Whether a kept sequence pauses between its commands. Those only run from the
 *  console, where the pause can be watched and stopped. */
export function hasPauses(command: string): boolean {
    return (sequenceSteps(command) ?? []).some((step) => step.kind === "wait");
}

/** A kept command on one line, for the places that have room for one. */
export function commandPreview(command: string): string {
    return command.split("\n").join(" | ");
}

/** What is wrong with a command already normalized, as a carried message, or
 *  null when it can be kept. A single line is held to what it always was; a
 *  sequence also to what "Run several" would run. */
export function savedCommandProblem(command: string): string | null {
    if (command.length === 0 || command.includes("\0")) {
        return gameMessage("games", "lib.noCommand");
    }
    if (!isSequence(command)) {
        return command.length > MAX_SAVED_COMMAND
            ? gameMessage("games", "lib.lineTooLong", { line: 1, max: MAX_SAVED_COMMAND })
            : null;
    }
    if (command.split("\n").length > MAX_SAVED_LINES) {
        return gameMessage("games", "lib.tooManyLines", { count: MAX_SAVED_LINES });
    }
    if (command.length > MAX_SAVED_SEQUENCE) {
        return gameMessage("games", "lib.sequenceTooLong", { max: MAX_SAVED_SEQUENCE });
    }
    const waitWithVariable = command.split("\n").findIndex((line) => /^\/?wait\s.*\{/i.test(line));
    if (waitWithVariable >= 0) {
        return gameMessage("games", "lib.waitVariable", { line: waitWithVariable + 1 });
    }
    return parseQueue(command, MAX_SAVED_COMMAND).problem;
}

/** One entry as it should be stored, or null when it is not usable at all.
 *
 *  Every line is trimmed and the empty ones dropped; what is left is refused if
 *  it is empty or too long, and a sequence also if "Run several" would refuse
 *  it. The label is cosmetic and is repaired rather than refused: an empty one
 *  becomes the command's first line, which is what somebody who did not bother
 *  naming it meant. */
export function normalizeSavedCommand(input: {
    id: string;
    label?: string | null;
    command: string;
    variables?: readonly CustomVariable[] | null;
}): SavedCommand | null {
    const command = normalizeCommandText(input.command);
    if (savedCommandProblem(command)) return null;
    const id = input.id.trim();
    if (id.length === 0 || id.length > 64) return null;
    const label = (input.label ?? "")
        .replace(/[\0\r\n]/g, " ")
        .trim()
        .slice(0, MAX_SAVED_LABEL);
    const variables = (input.variables ?? []).map(normalizeCustomVariable);
    if (customVariablesProblem(command, variables)) return null;
    return {
        id,
        label: label.length > 0 ? label : command.split("\n")[0]!.slice(0, MAX_SAVED_LABEL),
        command,
        ...(variables.length > 0 ? { variables } : {})
    };
}

/**
 * The list as the install recorded it.
 *
 * Anything unreadable is dropped rather than repaired: this is a settings blob a
 * future version may write differently, and half an entry is not a command
 * anybody should be offered a button for.
 */
export function readSavedCommands(config: Record<string, unknown>): SavedCommand[] {
    const raw = config[SAVED_COMMANDS_KEY];
    if (!Array.isArray(raw)) return [];
    const list: SavedCommand[] = [];
    for (const entry of raw) {
        if (typeof entry !== "object" || entry === null) continue;
        const row = entry as Record<string, unknown>;
        if (typeof row.id !== "string" || typeof row.command !== "string") continue;
        const variables = readCustomVariables(row.variables);
        const normalized =
            normalizeSavedCommand({
                id: row.id,
                label: typeof row.label === "string" ? row.label : null,
                command: row.command,
                variables
            }) ??
            // Variables a later version wrote differently are dropped, not the
            // command: the line itself is still one somebody kept.
            (variables.length > 0
                ? normalizeSavedCommand({
                      id: row.id,
                      label: typeof row.label === "string" ? row.label : null,
                      command: row.command
                  })
                : null);
        if (normalized && !list.some((kept) => kept.id === normalized.id)) list.push(normalized);
    }
    return list.slice(0, MAX_SAVED_COMMANDS);
}

/** The list with one entry added, or the entry of that id rewritten in place -
 *  editing must not move a button somebody has learned the position of. */
export function withSavedCommand(
    list: readonly SavedCommand[],
    entry: SavedCommand
): SavedCommand[] {
    if (list.some((kept) => kept.id === entry.id)) {
        return list.map((kept) => (kept.id === entry.id ? entry : kept));
    }
    if (list.length >= MAX_SAVED_COMMANDS)
        throw new Error(gameMessage("games", "lib.maxCommands", { count: MAX_SAVED_COMMANDS }));
    return [...list, entry];
}

export function withoutSavedCommand(list: readonly SavedCommand[], id: string): SavedCommand[] {
    return list.filter((kept) => kept.id !== id);
}

/** What pressing a kept command does: ask first, have the server fill it in,
 *  open a sequence with a blank in "Run several", run a sequence step by step,
 *  load a line with a blank into the box, or send it as it stands. */
export type KeptPress =
    | { readonly kind: "ask" }
    | { readonly kind: "fill" }
    | { readonly kind: "batch" }
    | { readonly kind: "queue"; readonly steps: readonly QueueStep[] }
    | { readonly kind: "refuse"; readonly problem: string }
    | { readonly kind: "load" }
    | { readonly kind: "send" };

/** How the console answers a kept command being pressed. */
export function keptPress(entry: SavedCommand, edition: MinecraftEdition | null): KeptPress {
    const declared = entry.variables ?? [];
    if (needsAsking(entry.command, edition, declared)) return { kind: "ask" };
    if (hasVariables(entry.command, edition, declared)) return { kind: "fill" };
    if (isSequence(entry.command)) {
        if (placeholderRange(entry.command)) return { kind: "batch" };
        const parsed = parseQueue(entry.command, MAX_CONSOLE_LINE);
        return parsed.problem
            ? { kind: "refuse", problem: parsed.problem }
            : { kind: "queue", steps: parsed.steps };
    }
    return placeholderRange(entry.command) ? { kind: "load" } : { kind: "send" };
}

/** Where the first blank to fill in is, or null for a command that is complete as
 *  it stands. The console loads the first kind into the box with the blank
 *  selected, and sends the second kind straight away. */
export function placeholderRange(command: string): { start: number; end: number } | null {
    const found = PLACEHOLDER.exec(command);
    return found?.index === undefined
        ? null
        : { start: found.index, end: found.index + found[0].length };
}
