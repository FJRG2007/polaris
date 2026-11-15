/**
 * Enigma's "/" commands as the composers offer them. Code hands every one to
 * the session's agent as typed, since Enigma is installed beside it there;
 * Chat offers only those whose instructions need no shell and no checkout.
 * Shared by the server, which filters, and both "/" lists, which rank.
 */

import * as polarSlash from "@/lib/polar/slash";

export type EnigmaSurface = "code" | "chat";

/** One command as a "/" list shows it: no instructions, they stay on the server. */
export interface EnigmaSlashCommand {
    readonly name: string;
    readonly description: string;
    readonly argumentHint: string | null;
}

/** Both composers' lists, as the commands route answers them. */
export interface EnigmaSlashLists {
    readonly code: readonly EnigmaSlashCommand[];
    readonly chat: readonly EnigmaSlashCommand[];
}

export const NO_ENIGMA_COMMANDS: EnigmaSlashLists = { code: [], chat: [] };

/** The commands one surface can run, without their instructions. */
export function enigmaSlashFor(
    commands: readonly (EnigmaSlashCommand & { readonly chat: boolean })[],
    surface: EnigmaSurface
): EnigmaSlashCommand[] {
    return commands
        .filter((command) => surface === "code" || command.chat)
        .map(({ name, description, argumentHint }) => ({ name, description, argumentHint }));
}

/**
 * The Enigma commands that match what was typed after the "/". One that shares
 * a name already on the list (a built-in, a skill, the person's own command)
 * steps aside, as Enigma's skills do for the person's own.
 */
export function matchEnigmaCommands(
    input: string,
    commands: readonly EnigmaSlashCommand[],
    taken: ReadonlySet<string>
): EnigmaSlashCommand[] {
    const query = polarSlash.slashQuery(input);
    if (query === null) return [];
    return polarSlash.rankedByShortcut(
        commands.filter((command) => !taken.has(command.name)),
        (command) => command.name,
        query
    );
}

/** A list read back from a cache or a response, keeping only well-formed rows. */
export function readEnigmaLists(raw: unknown): EnigmaSlashLists {
    const pick = (value: unknown): EnigmaSlashCommand[] =>
        Array.isArray(value)
            ? value.flatMap((row: unknown) => {
                  const entry = row as Partial<EnigmaSlashCommand> | null;
                  return entry && typeof entry.name === "string" && typeof entry.description === "string"
                      ? [
                            {
                                name: entry.name,
                                description: entry.description,
                                argumentHint: typeof entry.argumentHint === "string" ? entry.argumentHint : null
                            }
                        ]
                      : [];
              })
            : [];
    const lists = raw as Partial<Record<EnigmaSurface, unknown>> | null;
    return { code: pick(lists?.code), chat: pick(lists?.chat) };
}
