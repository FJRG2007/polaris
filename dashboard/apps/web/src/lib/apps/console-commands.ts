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
 * decides whether pressing it runs it or loads it into the box. Nothing else about
 * a saved command is interpreted: it is sent exactly as the console would send it,
 * through the same action, the same permission and the same audit line.
 *
 * Pure, so the dialog that validates a command as it is typed and the action that
 * stores it cannot disagree about what is allowed.
 */

/** One line somebody kept. */
export interface SavedCommand {
    readonly id: string;
    /** What the button says. Never empty - it falls back to the command itself. */
    readonly label: string;
    readonly command: string;
}

/** Where the list lives on the install's own settings blob. */
export const SAVED_COMMANDS_KEY = "consoleCommands";

/** Enough for the commands a server is actually run with, and few enough that the
 *  row of them above the input stays a row rather than a wall. */
export const MAX_SAVED_COMMANDS = 24;

export const MAX_SAVED_LABEL = 40;

/** The same ceiling the console itself takes, so nothing can be saved that could
 *  not then be sent. */
export const MAX_SAVED_COMMAND = 400;

/** A blank to be filled in before sending: `Broadcast <message>`. */
const PLACEHOLDER = /<[^<>\n]*>/;

/** One entry as it should be stored, or null when it is not usable at all.
 *
 *  A command is trimmed and refused if it is empty, too long, or carries a newline -
 *  a saved line that quietly became two commands is exactly the surprise nobody
 *  wants against a live server. The label is cosmetic and is repaired rather than
 *  refused: an empty one becomes the command, which is what somebody who did not
 *  bother naming it meant. */
export function normalizeSavedCommand(input: {
    id: string;
    label?: string | null;
    command: string;
}): SavedCommand | null {
    const command = input.command.trim();
    if (command.length === 0 || command.length > MAX_SAVED_COMMAND) return null;
    if (/[\0\r\n]/.test(command)) return null;
    const id = input.id.trim();
    if (id.length === 0 || id.length > 64) return null;
    const label = (input.label ?? "").replace(/[\0\r\n]/g, " ").trim().slice(0, MAX_SAVED_LABEL);
    return { id, label: label.length > 0 ? label : command.slice(0, MAX_SAVED_LABEL), command };
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
        const normalized = normalizeSavedCommand({
            id: row.id,
            label: typeof row.label === "string" ? row.label : null,
            command: row.command
        });
        if (normalized && !list.some((kept) => kept.id === normalized.id)) list.push(normalized);
    }
    return list.slice(0, MAX_SAVED_COMMANDS);
}

/** The list with one entry added, or the entry of that id rewritten in place -
 *  editing must not move a button somebody has learned the position of. */
export function withSavedCommand(list: readonly SavedCommand[], entry: SavedCommand): SavedCommand[] {
    if (list.some((kept) => kept.id === entry.id)) {
        return list.map((kept) => (kept.id === entry.id ? entry : kept));
    }
    if (list.length >= MAX_SAVED_COMMANDS) throw new Error(`Only ${MAX_SAVED_COMMANDS} commands can be kept`);
    return [...list, entry];
}

export function withoutSavedCommand(list: readonly SavedCommand[], id: string): SavedCommand[] {
    return list.filter((kept) => kept.id !== id);
}

/** Where the first blank to fill in is, or null for a command that is complete as
 *  it stands. The console loads the first kind into the box with the blank
 *  selected, and sends the second kind straight away. */
export function placeholderRange(command: string): { start: number; end: number } | null {
    const found = PLACEHOLDER.exec(command);
    return found?.index === undefined ? null : { start: found.index, end: found.index + found[0].length };
}
