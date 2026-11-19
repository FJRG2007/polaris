/**
 * A message that is a command: a slash, a word, and nothing else - `/online`.
 *
 * Kept apart from what answers one (`game-links`) so the send can ask this of
 * every message without loading the app registry for the ones that are not.
 */

/** A command as it is written. */
const COMMAND = /^\/([a-z][a-z0-9_-]{0,31})$/i;

/** The command a message body is, without its slash, or null. */
export function commandIn(body: string): string | null {
    const found = COMMAND.exec(body.trim());
    return found?.[1] ? found[1].toLowerCase() : null;
}

/** The commands Polaris's own apps answer, by what is typed after the slash - see `app-commands`. */
export const APP_COMMAND_NAMES: ReadonlySet<string> = new Set(["polar", "task"]);

/** A body that runs an app command: `/name`, then anything. */
const APP_COMMAND = /^\/([a-z][a-z0-9_-]{0,31})(?:\s+([\s\S]*))?$/i;

/** The app command a message body runs, and what was written after it, or null. */
export function appCommandIn(body: string): { readonly name: string; readonly text: string } | null {
    const found = APP_COMMAND.exec(body.trim());
    const name = found?.[1]?.toLowerCase();
    if (!name || !APP_COMMAND_NAMES.has(name)) return null;
    return { name, text: (found?.[2] ?? "").trim() };
}
