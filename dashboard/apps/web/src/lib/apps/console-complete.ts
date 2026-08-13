/**
 * Finishing a console command for somebody, from outside the game.
 *
 * A server knows its own commands exactly - every one the game ships and every one
 * a plugin added, with the arguments each of them takes - and it will tell a
 * connected client. It will not tell us. Polaris talks to a server over RCON and
 * `docker exec`, and neither carries the command tree; the panels that do offer
 * real completion all run *inside* the server as a plugin, which is a different
 * product with a different install.
 *
 * So this is a table rather than a query, and the trade is worth naming. It cannot
 * know about a plugin's commands, and it will not be wrong about the ones it does
 * know: these are the game's own, they have not moved in years, and the arguments
 * are filled from things Polaris already has - who is on the server right now, and
 * the items somebody has been handing out. Which makes it better than the in-game
 * version in one specific way, since walking a command tree returns the *name* of
 * an argument (`targets`, `item`) and never a value anybody wanted typed.
 *
 * Pure, and unaware of React: the screen decides where to draw a list, this decides
 * what is in it.
 */

/** What a position in a command wants, when it wants something nameable. */
export type ArgumentKind = "player" | "item" | "gamerule" | "boolean" | "free";

export interface CommandSpec {
    readonly name: string;
    /** What each position takes, in order. A position past the end is `free`, which
     *  offers nothing rather than guessing. */
    readonly args: readonly ArgumentKind[];
}

/**
 * The commands a Java server takes, as an operator types them from a panel.
 *
 * Curated rather than exhaustive on purpose. Every one here is a command the game
 * itself ships and has shipped for years; the ones left out are the ones nobody
 * reaches for from a web console - the world-editing family, which wants
 * coordinates and a target selector and is miserable to type anywhere but in-game.
 */
export const JAVA_COMMANDS: readonly CommandSpec[] = [
    { name: "ban", args: ["player", "free"] },
    { name: "ban-ip", args: ["free", "free"] },
    { name: "banlist", args: [] },
    { name: "clear", args: ["player", "item"] },
    { name: "deop", args: ["player"] },
    { name: "defaultgamemode", args: ["free"] },
    { name: "difficulty", args: ["free"] },
    { name: "effect", args: ["free", "player"] },
    { name: "enchant", args: ["player", "free"] },
    { name: "experience", args: ["free", "free", "player"] },
    { name: "gamemode", args: ["free", "player"] },
    { name: "gamerule", args: ["gamerule", "boolean"] },
    { name: "give", args: ["player", "item", "free"] },
    { name: "help", args: [] },
    { name: "kick", args: ["player", "free"] },
    { name: "kill", args: ["player"] },
    { name: "list", args: [] },
    { name: "me", args: ["free"] },
    { name: "op", args: ["player"] },
    { name: "pardon", args: ["player"] },
    { name: "pardon-ip", args: ["free"] },
    { name: "save-all", args: ["free"] },
    { name: "save-off", args: [] },
    { name: "save-on", args: [] },
    { name: "say", args: ["free"] },
    { name: "seed", args: [] },
    { name: "setidletimeout", args: ["free"] },
    { name: "setworldspawn", args: ["free"] },
    { name: "spawnpoint", args: ["player"] },
    { name: "stop", args: [] },
    { name: "teleport", args: ["player", "player"] },
    { name: "tell", args: ["player", "free"] },
    { name: "time", args: ["free", "free"] },
    { name: "title", args: ["player", "free"] },
    { name: "tp", args: ["player", "player"] },
    { name: "weather", args: ["free", "free"] },
    { name: "whitelist", args: ["free", "player"] },
    { name: "xp", args: ["free", "free", "player"] }
];

/**
 * And what a Bedrock server takes, which is not the same list.
 *
 * The differences are the ones that catch people: the list of who may join is the
 * `allowlist` and not the whitelist, and saving is a three-step conversation rather
 * than one command. A completer that offered Java's spelling on a Bedrock server
 * would be teaching the wrong thing.
 */
export const BEDROCK_COMMANDS: readonly CommandSpec[] = [
    { name: "allowlist", args: ["free", "player"] },
    { name: "clear", args: ["player", "item"] },
    { name: "deop", args: ["player"] },
    { name: "difficulty", args: ["free"] },
    { name: "effect", args: ["player", "free"] },
    { name: "gamemode", args: ["free", "player"] },
    { name: "gamerule", args: ["gamerule", "boolean"] },
    { name: "give", args: ["player", "item", "free"] },
    { name: "help", args: [] },
    { name: "kick", args: ["player", "free"] },
    { name: "kill", args: ["player"] },
    { name: "list", args: [] },
    { name: "me", args: ["free"] },
    { name: "op", args: ["player"] },
    { name: "save", args: ["free"] },
    { name: "say", args: ["free"] },
    { name: "setworldspawn", args: ["free"] },
    { name: "spawnpoint", args: ["player"] },
    { name: "stop", args: [] },
    { name: "tell", args: ["player", "free"] },
    { name: "time", args: ["free", "free"] },
    { name: "title", args: ["player", "free"] },
    { name: "tp", args: ["player", "player"] },
    { name: "transfer", args: ["player", "free"] },
    { name: "weather", args: ["free"] },
    { name: "xp", args: ["free", "player"] }
];

/**
 * ARK's admin commands, spelled the way ARK spells them.
 *
 * Every one of these is a command Polaris already sends somewhere else in the app,
 * which is what makes the list trustworthy rather than remembered: the ones the
 * moderation screens run are the ones an operator would reach for by hand.
 */
export const ARK_COMMANDS: readonly CommandSpec[] = [
    { name: "Broadcast", args: ["free"] },
    { name: "BanPlayer", args: ["player"] },
    { name: "DestroyWildDinos", args: [] },
    { name: "DoExit", args: [] },
    { name: "GetChat", args: [] },
    { name: "KickPlayer", args: ["player"] },
    { name: "ListPlayers", args: [] },
    { name: "SaveWorld", args: [] },
    { name: "ServerChat", args: ["free"] },
    { name: "ServerChatTo", args: ["player", "free"] },
    { name: "SetTimeOfDay", args: ["free"] },
    { name: "ShowMessageOfTheDay", args: [] },
    { name: "UnbanPlayer", args: ["player"] }
];

/** Which table a server's console draws from. */
export function commandsFor(game: "java" | "bedrock" | "ark"): readonly CommandSpec[] {
    if (game === "ark") return ARK_COMMANDS;
    return game === "bedrock" ? BEDROCK_COMMANDS : JAVA_COMMANDS;
}

/** What is known that could fill an argument. */
export interface CompletionSources {
    readonly game: "java" | "bedrock" | "ark";
    /** Who is on right now. The screen has this already - it is the roster it draws. */
    readonly players: readonly string[];
    /** Item ids worth offering, e.g. the ones this server has been handing out. */
    readonly items: readonly string[];
    /** Rule names, from the catalogue the rules screen already uses. */
    readonly rules: readonly string[];
}

export interface Completion {
    /** What to offer, already filtered by what has been typed. */
    readonly options: readonly string[];
    /** Where in the line the token being completed starts, so the caller can splice
     *  rather than guess. */
    readonly from: number;
    /** The part already typed. */
    readonly token: string;
}

const BOOLEANS = ["true", "false"];

/**
 * What could come next, given a line and where the caret is in it.
 *
 * The token under the caret is what matters, not the whole line: somebody editing
 * the middle of a command is completing the word they are in, and completing the
 * last word instead is the behaviour that makes a suggestion list something people
 * turn off.
 *
 * A caret sitting immediately after a space is a new, empty token - which is when
 * the whole list for that position is worth showing, and the one moment a completer
 * that only ever filters would go quiet.
 */
export function completeConsole(line: string, caret: number, sources: CompletionSources): Completion {
    const upto = line.slice(0, Math.max(0, Math.min(caret, line.length)));
    // A leading slash is stripped before the command runs, so it is not part of the
    // first word here either - otherwise everything is off by the one character.
    const offset = upto.startsWith("/") ? 1 : 0;
    const typed = upto.slice(offset);
    const parts = typed.split(" ");
    const token = parts.at(-1) ?? "";
    const from = offset + typed.length - token.length;
    const index = parts.length - 1;

    const narrow = (options: readonly string[]): Completion => ({
        options: options.filter((option) => option.toLowerCase().startsWith(token.toLowerCase())),
        from,
        token
    });

    // Nothing typed is not a question. An empty box offering every command the
    // game has is a list in the way of somebody who came to type `stop`, and it
    // appears the moment the console is opened - so the command list waits for a
    // first character. An empty token *after* a space is different: that is a
    // position in a command somebody is already writing, and the whole list for
    // that position is exactly what helps.
    if (index === 0) {
        if (token.length === 0) return { options: [], from, token };
        return narrow(commandsFor(sources.game).map((command) => command.name));
    }

    const command = commandsFor(sources.game).find(
        (entry) => entry.name.toLowerCase() === (parts[0] ?? "").toLowerCase()
    );
    if (!command) return { options: [], from, token };

    switch (command.args[index - 1]) {
        case "player":
            return narrow(sources.players);
        case "item":
            // Matched on the short name as well as the whole id, because nobody
            // types `minecraft:` first and then goes looking for a list. The id
            // that goes in is still the full one - the game wants the namespace.
            return {
                options: sources.items.filter((id) => {
                    const wanted = token.toLowerCase();
                    const short = id.slice(id.indexOf(":") + 1).toLowerCase();
                    return id.toLowerCase().startsWith(wanted) || short.startsWith(wanted);
                }),
                from,
                token
            };
        case "gamerule":
            return narrow(sources.rules);
        case "boolean":
            return narrow(BOOLEANS);
        default:
            // Nothing worth guessing at. A message, a number, a coordinate - a list
            // here would be noise in front of somebody who knows what they are
            // typing.
            return { options: [], from, token };
    }
}

/**
 * The line with the chosen option put in place of the token being typed.
 *
 * Returned whole rather than as an edit, because the caller has to move the caret
 * too and both are one decision. A trailing space follows the completion so the
 * next argument can be typed without reaching for the space bar - which is also
 * what makes the list immediately offer the next position.
 */
export function applyCompletion(line: string, completion: Completion, option: string): { line: string; caret: number } {
    const head = line.slice(0, completion.from);
    const tail = line.slice(completion.from + completion.token.length);
    const inserted = `${option} `;
    return { line: `${head}${inserted}${tail}`, caret: head.length + inserted.length };
}
