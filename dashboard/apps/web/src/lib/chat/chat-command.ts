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
