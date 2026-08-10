/**
 * Reading what an ARK server said back.
 *
 * Everything here is console prose, not a schema, so each parser is written to
 * survive lines it does not recognise: the command is run through arkmanager,
 * which prints its own banner before the server's answer, and the answer itself
 * has changed shape between releases.
 *
 * The one distinction worth being careful about is empty against unreadable. A
 * server with nobody on it says so in a sentence; a server that is still loading
 * its world says nothing at all, and reporting that silence as "nobody is
 * playing" is how a panel ends up claiming an empty server that is not a server
 * yet.
 */

export interface ArkPlayer {
    /** The character name, which is what a moderator recognises. */
    readonly name: string;
    /** Their SteamID64, which is what a rule is written against. */
    readonly steamId: string;
}

/** `0. Survivor, 76561198012345678` - an index, a name that may hold anything
 *  including commas, and the id at the end. */
const PLAYER_LINE = /^\s*\d+\.\s*(.+),\s*(\d{17})\s*$/;

/** What the server says when there is nobody on it. */
const NOBODY = /no players connected/i;

/**
 * Who is on, or null when the output is not an answer to the question.
 *
 * Null is not "nobody": it is what a caller gets from a server that has not
 * finished starting, and it has to stay distinguishable from an empty list.
 */
export function parseArkPlayers(output: string): ArkPlayer[] | null {
    const players: ArkPlayer[] = [];
    let answered = false;
    for (const line of output.split(/\r?\n/)) {
        if (NOBODY.test(line)) answered = true;
        const match = PLAYER_LINE.exec(line);
        if (!match) continue;
        answered = true;
        players.push({ name: match[1]!.trim(), steamId: match[2]! });
    }
    return answered ? players : null;
}

/**
 * Whether the server took a command that answers with nothing useful.
 *
 * Adding somebody to the allow list prints a confirmation on some builds and
 * nothing at all on others, so the absence of an error is what counts. What is
 * never a success is the RCON client failing to reach the server, which prints
 * its own refusal rather than the server's.
 */
const REFUSALS = [/connection refused/i, /couldn't connect/i, /could not connect/i, /connection timed out/i, /no such file/i];

export function isRconRefusal(output: string): boolean {
    return REFUSALS.some((pattern) => pattern.test(output));
}
