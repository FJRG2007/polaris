/**
 * Nothing of Polaris's on the screen of a player who has not logged in yet.
 *
 * On a server with Polaris login, a player who joins is held - in the dark,
 * with only the `/login` or `/register` prompt - until Polaris has checked their
 * password. The mod (NeoForge) and the plugin (Paper, Purpur, Spigot) mark that
 * player with the entity tag `polaris_pending` for exactly as long as they are
 * held, and take it off the moment they are let in, leave, or the server stops.
 *
 * Everything Polaris says to players in the game goes through three commands -
 * `tellraw`, `title` and `playsound` - so every such line is narrowed here, on
 * its way to the server, to the players without that tag: `@a` becomes
 * `@a[tag=!polaris_pending]`, and a line to one player by name runs as that
 * player only when they are without the tag. The name stays a name, so the game
 * finds the player in any case, as it did before. A server where nobody carries the tag
 * (no Polaris login, or everybody logged in) reads exactly what it read before.
 * What only reads or counts, and what an event does to the world, is left as it
 * was: a held player cannot do anything anyway, and a cleanup that skipped them
 * would leave its marks on them.
 *
 * Boss bars and the side panel are the mod's and the plugin's to keep off a held
 * player's screen, not this file's: a bar's player list is kept, not rewritten,
 * so each bar comes back by itself the moment they are let in - including one
 * that was handed to everybody while they waited and is never handed out again.
 *
 * Pure, so every rewrite is asserted in a test.
 */

import { readLevels } from "./player-events";
import { canonicalReplies } from "./events/replies";
import { COMMAND_BYTES_MAX, commandBytes } from "./command-size";

/** The tag the mod and the plugin put on a player who has not logged in yet.
 *  Kept in step with `PENDING_TAG` in both. */
export const PENDING_TAG = "polaris_pending";

const NOT_PENDING = `tag=!${PENDING_TAG}`;

/** A player's name as a command may carry it: Java's, or Floodgate's `.` in
 *  front of a Bedrock player's. */
const PLAYER_NAME = /^\.?[A-Za-z0-9_]{1,16}$/;

/** What `execute` aims at somebody with: the name it can take in place of a
 *  selector follows one of these. */
const AIMING = new Set(["as", "at"]);

/** What follows `as <name>` so the rest runs only for a player who is in. */
const AS_IN = `if entity @s[${NOT_PENDING}]`;

/** What follows `at <name>` so the rest runs only where a player who is in
 *  stands, without changing who runs it. */
const AT_IN = `if entity @a[${NOT_PENDING},distance=..0.01]`;

/** The verbs that show something to a player. */
type Shown = "tellraw" | "title" | "playsound";

function shownVerb(word: string): Shown | null {
    const verb = word.replace(/^minecraft:/, "");
    return verb === "tellraw" || verb === "title" || verb === "playsound" ? verb : null;
}

/** One word of a command and where it starts: a selector's brackets and a
 *  quoted string are read whole, so a space inside either does not end it. */
interface Word {
    readonly start: number;
    readonly end: number;
}

function nextWord(line: string, from: number): Word | null {
    let start = from;
    while (start < line.length && line[start] === " ") start += 1;
    if (start >= line.length) return null;
    let at = start;
    let depth = 0;
    let quote: string | null = null;
    while (at < line.length) {
        const char = line[at] as string;
        if (quote) {
            if (char === "\\") at += 1;
            else if (char === quote) quote = null;
        } else if (char === '"' || char === "'") quote = char;
        else if (char === "[" || char === "{") depth += 1;
        else if (char === "]" || char === "}") depth = Math.max(0, depth - 1);
        else if (char === " " && depth === 0) break;
        at += 1;
    }
    return { start, end: at };
}

/** A target narrowed to the players who are in: a selector gets the tag test.
 *  `@s` is whoever `execute` already chose, and a name is narrowed by the line
 *  around it (`hiddenFromPending`), never turned into a selector: a selector's
 *  `name=` matches the case exactly, where the name itself finds the player in
 *  any case. A UUID or anything else is left as it is. */
export function narrowedTarget(target: string): string {
    const selector = /^@([aepr])(\[(.*)\])?$/s.exec(target);
    if (!selector) return target;
    const inside = selector[3] ?? "";
    if (new RegExp(`tag=!?${PENDING_TAG}(?![A-Za-z0-9_.+-])`).test(inside)) return target;
    return `@${selector[1]}[${inside.trim() ? `${inside},` : ""}${NOT_PENDING}]`;
}

/** Whether `execute` already tests the player it aimed at by name, right after
 *  the name. */
function guarded(line: string, after: number, guard: string): boolean {
    const end = after + guard.length + 1;
    return line.startsWith(` ${guard}`, after) && (end === line.length || line[end] === " ");
}

/** Where the target of a showing verb is, counted in words after the verb:
 *  `playsound <sound> <source> <targets>`, the others first. */
function targetIndex(verb: Shown): number {
    return verb === "playsound" ? 2 : 0;
}

/**
 * A line as it is sent to the server: narrowed to the players who are in when
 * it shows something to somebody, and as it was otherwise. Also as it was when
 * the narrowed line would be longer than the console tool sends - the mod still
 * keeps it off a held player's screen there, and a line that vanishes reaches
 * nobody at all.
 */
export function hiddenFromPending(line: string): string {
    const slash = line.startsWith("/") ? 1 : 0;
    const first = nextWord(line, slash);
    if (!first) return line;
    const replacements: { word: Word; text: string }[] = [];
    let verbWord: Word = first;
    let verb = line.slice(first.start, first.end).replace(/^minecraft:/, "");
    while (verb === "execute") {
        // Every selector `execute` names on the way to a showing command, and a
        // name it aims with, narrowed: `as @a at @s run playsound ... @s` plays
        // to whoever `as` chose.
        let previous = "";
        let at = verbWord.end;
        let found: Word | null = null;
        for (let word = nextWord(line, at); word; word = nextWord(line, at)) {
            const text = line.slice(word.start, word.end);
            at = word.end;
            if (text === "run") {
                found = nextWord(line, at);
                break;
            }
            if (text.startsWith("@")) {
                const narrowed = narrowedTarget(text);
                if (narrowed !== text) replacements.push({ word, text: narrowed });
            } else if (AIMING.has(previous) && PLAYER_NAME.test(text)) {
                const guard = previous === "as" ? AS_IN : AT_IN;
                if (!guarded(line, word.end, guard))
                    replacements.push({ word, text: `${text} ${guard}` });
            }
            previous = text;
        }
        if (!found) return line;
        verbWord = found;
        verb = line.slice(found.start, found.end).replace(/^minecraft:/, "");
    }
    const shown = shownVerb(verb);
    if (!shown) return line;
    const words: Word[] = [];
    let at = verbWord.end;
    const index = targetIndex(shown);
    for (let word = nextWord(line, at); word && words.length <= index; word = nextWord(line, at)) {
        words.push(word);
        at = word.end;
    }
    const word = words[index];
    if (word) {
        const text = line.slice(word.start, word.end);
        if (PLAYER_NAME.test(text)) {
            const before = { start: verbWord.start, end: verbWord.start };
            replacements.push(
                { word: before, text: `execute as ${text} ${AS_IN} run ` },
                { word, text: "@s" }
            );
        } else {
            const narrowed = narrowedTarget(text);
            if (narrowed !== text) replacements.push({ word, text: narrowed });
        }
    }
    if (replacements.length === 0) return line;
    let out = line;
    for (const { word, text } of [...replacements].sort((a, b) => b.word.start - a.word.start))
        out = `${out.slice(0, word.start)}${text}${out.slice(word.end)}`;
    return commandBytes(out) <= COMMAND_BYTES_MAX ? out : line;
}

/** The same for a command given as its words: one line when it changed, so the
 *  console tool sends exactly that. */
export function hiddenFromPendingArgv(argv: readonly string[]): readonly string[] {
    const line = argv.join(" ");
    const narrowed = hiddenFromPending(line);
    return narrowed === line ? argv : [narrowed];
}

/** Who is still at the login prompt: one answer per held player, nothing at all
 *  on a server where nobody is held or nothing holds anybody. */
export const PENDING_READ = `execute as @a[tag=${PENDING_TAG}] run data get entity @s XpLevel`;

/** The names in that answer, read with the names online (`list`) so a team's
 *  prefix or a number run into the next name never misreads one. */
export function pendingNames(output: string, roster: readonly string[]): string[] {
    if (!output.trim()) return [];
    return readLevels(canonicalReplies(output, roster).text).map((one) => one.name);
}

/** Who is online as the players see it: the ones still at the login prompt
 *  left out, by name in any case. */
export function withoutPending<
    T extends { readonly online: number; readonly players: readonly string[] }
>(list: T, pending: readonly string[]): T {
    if (pending.length === 0) return list;
    const held = new Set(pending.map((name) => name.toLowerCase()));
    const players = list.players.filter((name) => !held.has(name.toLowerCase()));
    const gone = list.players.length - players.length;
    return { ...list, players, online: Math.max(0, list.online - gone) };
}
