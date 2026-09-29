/**
 * Everybody's answer to one read, made readable by name.
 *
 * An event asks about every player at once - `execute as @a run data get entity
 * @s Pos` - and the game answers once per player, but not in a form a name can
 * be taken out of safely:
 *
 * - The name is the player's DISPLAY name: a team's prefix and suffix around it
 *   (`[VIP] Ana [AFK] has ...`), for `data get` always and for `scoreboard
 *   players get` from 1.20.3.
 * - Vanilla, Fabric and Paper put nothing between two answers, so a number is
 *   followed straight by the next name: `... data: 0Ben has ...`, and `02Fast`
 *   after a 0 reads as the number 2 and a player called Fast.
 * - A Bedrock player through Floodgate is `.Name`, and reading it as `Name` is
 *   somebody else.
 * - RCON sends at most 4096 characters of an answer, and the console tool reads
 *   only that much - or nothing at all, `response too long`, when an accent
 *   makes it more than 4096 bytes. Everybody past that was not there.
 *
 * So each answer is rewritten to one line per player with the name the game
 * knows them by, as the readers expect it, with the names online (`list uuids`,
 * which prints them plain) asked for only when the answer cannot be split
 * without them; and one too long for a single packet is asked again twenty
 * players at a time.
 *
 * Pure: the transport that asks is `events-service`'s.
 */

import { stripFormatting } from "../parse";

const ENTITY_DATA = " has the following entity data: ";
const SCORE = / has (-?\d+) \[/g;
/** A number as the game prints one: `0`, `-12`, `64.5d`, `1.0E7d`, `90.0f`. */
const NUMBER = /^-?\d+(?:\.\d+)?(?:E-?\d+)?[bsLfdBSFD]?/;
/** A name as the game can print one: Java's, or Floodgate's `.` in front of it. */
const NAME = /^\.?[A-Za-z0-9_]{1,16}$/;

/** The roster out of `list uuids`: `... online: Ana (uuid), .Bo (uuid)`. */
export const ROSTER = "list uuids";

export function rosterNames(output: string): string[] {
    const tail = /players online:?(.*)$/s.exec(stripFormatting(output))?.[1] ?? "";
    return tail
        .split(",")
        .map((entry) => entry.trim().split(/\s+/)[0] ?? "")
        .filter((name) => NAME.test(name));
}

/** Whether a line asks every player one thing, and so is answered once each. */
export function isPlayerRead(line: string): boolean {
    return /\bas @a(?:\[[^\]]*\])? (?:.* )?run (?:minecraft:)?(?:data get entity @s|scoreboard players get @s) /.test(
        line
    );
}

/** Whether an answer is only its first packet's worth, or never arrived for being too long. */
export function cutShort(output: string): boolean {
    return output.length >= 4000 || /response too long/i.test(output);
}

/**
 * The same read, twenty players at a time: each page tagged first, read by the
 * tag, then marked as seen. Tags only players carry and only while the read
 * lasts, all `pe_`. Null for a line with no `as @a` to page.
 */
export function pagedRead(line: string): {
    start: string[];
    tagPage: string;
    readPage: string;
    next: string[];
    end: string[];
} | null {
    const found = /^(.*?\bas )@a(?:\[([^\]]*)\])?( .*)$/.exec(line);
    if (!found) return null;
    const [, before, filters, after] = found as unknown as [
        string,
        string,
        string | undefined,
        string
    ];
    const selector = (extra: string) => `@a[${filters ? `${filters},` : ""}${extra}]`;
    return {
        start: ["tag @a remove pe_seen", "tag @a remove pe_page"],
        tagPage: `${before}${selector("tag=!pe_seen,limit=20")} run tag @s add pe_page`,
        readPage: `${before}${selector("tag=pe_page")}${after}`,
        next: ["tag @a[tag=pe_page] add pe_seen", "tag @a remove pe_page"],
        end: ["tag @a remove pe_seen"]
    };
}

/** Whether a page's tagging found anybody: `Added tag 'pe_page' to Ana`. */
export function pageTagged(output: string): boolean {
    return /added tag/i.test(output);
}

/**
 * Which player a display name is: the one online whose name ends latest in it
 * (a suffix may follow), the longest where two end together; without a roster,
 * the last word that could be a name.
 */
export function nameIn(display: string, roster: readonly string[] | null): string | null {
    const text = display.trim();
    if (roster) {
        if (roster.includes(text)) return text;
        let best: { name: string; end: number } | null = null;
        for (const name of roster) {
            const at = text.lastIndexOf(name);
            if (at < 0) continue;
            const end = at + name.length;
            if (!best || end > best.end || (end === best.end && name.length > best.name.length))
                best = { name, end };
        }
        if (best) return best.name;
    }
    return (
        text
            .split(/\s+/)
            .filter((word) => NAME.test(word))
            .at(-1) ?? null
    );
}

/** How long the SNBT value at the start is, when it closes itself: a list, a
 *  compound or a quoted string. -1 for a number, which does not. */
function closedValue(text: string): number {
    const open = text[0];
    if (open === '"' || open === "'") {
        for (let index = 1; index < text.length; index += 1) {
            if (text[index] === "\\") index += 1;
            else if (text[index] === open) return index + 1;
        }
        return text.length;
    }
    if (open !== "[" && open !== "{") return -1;
    let depth = 0;
    let quote: string | null = null;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index] as string;
        if (quote) {
            if (char === "\\") index += 1;
            else if (char === quote) quote = null;
        } else if (char === '"' || char === "'") quote = char;
        else if (char === "[" || char === "{") depth += 1;
        else if (char === "]" || char === "}") {
            depth -= 1;
            if (depth === 0) return index + 1;
        }
    }
    return text.length;
}

/**
 * A number glued to the display name after it, split where a name online
 * begins: the one ending latest, whose text before it starts with a number.
 */
function splitGlued(
    text: string,
    roster: readonly string[]
): { value: string; display: string } | null {
    let best: { at: number; end: number; name: string; value: string } | null = null;
    for (const name of roster) {
        for (let at = text.indexOf(name, 1); at >= 0; at = text.indexOf(name, at + 1)) {
            const value = NUMBER.exec(text.slice(0, at))?.[0];
            if (!value) continue;
            const end = at + name.length;
            if (!best || end > best.end || (end === best.end && name.length > best.name.length))
                best = { at, end, name, value };
        }
    }
    return best ? { value: best.value, display: text.slice(best.value.length) } : null;
}

export interface Canonical {
    /** One line per player, `Name has ...`, as the readers expect it. */
    readonly text: string;
    /** Whether the names online would read it better than it was read. */
    readonly needsRoster: boolean;
}

/** An answer rewritten one line per player, by the name the game knows them by. */
export function canonicalReplies(output: string, roster: readonly string[] | null): Canonical {
    const text = stripFormatting(output).replace(/\u001b/g, "");
    const parts = text.split(ENTITY_DATA);
    if (parts.length > 1) return entityAnswers(parts, roster);
    const scores = [...text.matchAll(SCORE)];
    if (scores.length > 0) return scoreAnswers(text, scores, roster);
    return { text: output, needsRoster: false };
}

function named(
    display: string,
    roster: readonly string[] | null
): { name: string; unsure: boolean } {
    const trimmed = display.trim();
    const name = nameIn(trimmed, roster);
    return { name: name ?? trimmed, unsure: !NAME.test(trimmed) || name === null };
}

function entityAnswers(parts: string[], roster: readonly string[] | null): Canonical {
    let needsRoster = false;
    const lines: string[] = [];
    let display = parts[0] as string;
    for (let index = 1; index < parts.length; index += 1) {
        const piece = parts[index] as string;
        const last = index === parts.length - 1;
        let value: string;
        let next = "";
        if (last) value = piece.trimEnd();
        else {
            const closed = closedValue(piece);
            const number = NUMBER.exec(piece)?.[0] ?? "";
            if (closed >= 0) {
                value = piece.slice(0, closed);
                next = piece.slice(closed);
            } else if (/^\s/.test(piece.slice(number.length))) {
                value = number;
                next = piece.slice(number.length);
            } else {
                // A number straight against the next name: only the names
                // online can say where one ends and the other begins.
                const glued = roster ? splitGlued(piece, roster) : null;
                if (!glued) needsRoster = true;
                value = glued?.value ?? number;
                next = glued?.display ?? piece.slice(number.length);
            }
        }
        const who = named(display, roster);
        if (who.unsure && !roster) needsRoster = true;
        lines.push(`${who.name}${ENTITY_DATA}${value}`);
        display = next;
    }
    return { text: lines.join("\n"), needsRoster };
}

function scoreAnswers(
    text: string,
    scores: RegExpMatchArray[],
    roster: readonly string[] | null
): Canonical {
    // Every answer names the same objective, so the last one - with nothing
    // after it - says what its bracket holds.
    const lastMatch = scores.at(-1)!;
    const tail = text.slice(lastMatch.index! + lastMatch[0].length).trimEnd();
    const title = tail.endsWith("]") ? tail.slice(0, -1) : tail;
    let needsRoster = false;
    const lines: string[] = [];
    let display = text.slice(0, scores[0]!.index);
    scores.forEach((match, index) => {
        const who = named(display, roster);
        if (who.unsure && !roster) needsRoster = true;
        lines.push(`${who.name} has ${match[1]} [${title}]`);
        const following = scores[index + 1];
        if (!following) return;
        const after = text.slice(match.index! + match[0].length, following.index);
        display = after.startsWith(`${title}]`)
            ? after.slice(title.length + 1)
            : after.slice(after.indexOf("]") + 1);
    });
    return { text: lines.join("\n"), needsRoster };
}
