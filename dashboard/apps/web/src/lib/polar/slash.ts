/**
 * The "/" list's matching, shared by Chat's composer and Code's: how a
 * shortcut ranks against what was typed, and the person's own command a
 * message starts with.
 */

import * as polarShared from "@/lib/polar/shared";

/** How well a shortcut answers what was typed after the "/": 0 when it starts
 *  with it, 1 when it holds it, 2 when it holds its letters in order; null when
 *  it does not match at all. */
export function shortcutRank(shortcut: string, query: string): number | null {
    if (shortcut.startsWith(query)) return 0;
    if (shortcut.includes(query)) return 1;
    let at = 0;
    for (const letter of shortcut) if (letter === query[at]) at++;
    return at === query.length ? 2 : null;
}

/** The items whose shortcut matches, best first, ties in their own order. */
export function rankedByShortcut<T>(items: readonly T[], key: (item: T) => string, query: string): T[] {
    return items
        .map((item, index) => ({ item, index, rank: shortcutRank(key(item), query) }))
        .filter((entry): entry is { item: T; index: number; rank: number } => entry.rank !== null)
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map((entry) => entry.item);
}

/** What was typed after the "/", or null once it is not a lone "/" token (a
 *  command with words after it is a message). */
export function slashQuery(input: string): string | null {
    if (!input.startsWith("/") || /\s/.test(input)) return null;
    return input.slice(1).toLowerCase();
}

/** The person's command a message starts with, and what follows its shortcut. */
export function ownCommandIn(
    raw: string,
    own: readonly polarShared.PolarCommandRow[]
): { row: polarShared.PolarCommandRow; rest: string } | null {
    const found = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(raw.trim());
    if (!found) return null;
    const shortcut = polarShared.normalizeShortcut(found[1] ?? "");
    const row = own.find((entry) => entry.shortcut === shortcut);
    return row ? { row, rest: found[2] ?? "" } : null;
}

/** A message with the person's command it starts with spelled out, as Chat
 *  sends it; any other message as it is. */
export function withOwnCommand(raw: string, own: readonly polarShared.PolarCommandRow[]): string {
    const found = ownCommandIn(raw, own);
    return found ? polarShared.commandText(found.row.prompt, found.rest) : raw;
}
