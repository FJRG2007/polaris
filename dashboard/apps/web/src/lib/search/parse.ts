/**
 * Turning what was typed into a command.
 *
 * Three ways in, because people reach for different ones: "/services" is the
 * deliberate spelling, "@ana" is the one everybody already knows from every
 * comment box, and "services orphion" is what somebody types when they were not
 * thinking about commands at all. All three end at the same place - a scope and
 * the words after it.
 *
 * A bare word only becomes a command once a space follows it, so "apps" still
 * finds the Apps page while "apps grafana" searches installed apps.
 *
 * A slashed word can take effect the moment it is complete, but only when no
 * longer command starts with it. "/task" is not taken, because the next
 * keystroke may well be the "s" of "/tasks" - taking it would swallow that "s"
 * into the query and search tasks for "s orphion". "/svc" has nothing after it
 * and is taken at once. Either way the space still commits, so "/task " works.
 */

import { SEARCH_SCOPE_LIST, type SearchScopeDefinition } from "@/lib/search/scopes";

export interface ActiveCommand {
    readonly scope: SearchScopeDefinition;
    /** What was typed after the command. Empty is a command with no query yet. */
    readonly term: string;
}

const BY_KEYWORD = new Map<string, SearchScopeDefinition>();
for (const scope of SEARCH_SCOPE_LIST) {
    for (const keyword of scope.keywords) {
        const held = BY_KEYWORD.get(keyword);
        // Two scopes answering to one word would make which of them opens depend
        // on the order of the registry.
        if (held) throw new Error(`"${keyword}" activates both ${held.id} and ${scope.id}`);
        BY_KEYWORD.set(keyword, scope);
    }
}

const SIGILS = SEARCH_SCOPE_LIST.filter((scope) => scope.sigil);

/** Keywords no other keyword continues, so finishing one means finishing it. */
const KEYWORDS = [...BY_KEYWORD.keys()];
const TERMINAL = new Set(
    KEYWORDS.filter((keyword) => !KEYWORDS.some((other) => other !== keyword && other.startsWith(keyword)))
);

/** A command word: letters, digits and dashes, nothing that needs escaping. */
const COMMAND = /^\/?([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i;

/**
 * The command the text opens with, or null when it is an ordinary search.
 *
 * @param raw - The field as typed, before any command has been taken off it.
 */
export function detectCommand(raw: string): ActiveCommand | null {
    const text = raw.trimStart();
    if (!text) return null;

    for (const scope of SIGILS) {
        if (text.startsWith(scope.sigil!)) return { scope, term: text.slice(scope.sigil!.length).trimStart() };
    }

    const match = COMMAND.exec(text);
    if (!match) return null;
    const keyword = match[1]!.toLowerCase();
    const scope = BY_KEYWORD.get(keyword);
    if (!scope) return null;
    // A space after the word commits it either way. Without one, only a slashed
    // word no other command continues is taken; a bare word is left alone, which
    // is what keeps a one-word search from being hijacked.
    const committed = match[2] !== undefined || /\s$/.test(text);
    if (!committed && !(text.startsWith("/") && TERMINAL.has(keyword))) return null;
    return { scope, term: (match[2] ?? "").trimStart() };
}

/**
 * Commands worth offering for a half-typed word, so they can be discovered by
 * writing rather than by being told. A lone "/" offers all of them.
 */
export function commandSuggestions(raw: string): SearchScopeDefinition[] {
    const text = raw.trimStart();
    if (!text) return [];
    const slashed = text.startsWith("/");
    const token = (slashed ? text.slice(1) : text).toLowerCase();
    if (!slashed && !token) return [];
    // A space means the word is finished: either it was a command, and
    // `detectCommand` has it, or it never was one.
    if (/\s/.test(token)) return [];
    if (!token) return [...SEARCH_SCOPE_LIST];

    // A word already taken as a command never reaches here - the field holds the
    // query by then - so a complete keyword shown here is one still waiting for
    // its space, and Enter or Tab is how it is taken.
    return SEARCH_SCOPE_LIST.filter((scope) => scope.keywords.some((keyword) => keyword.startsWith(token)));
}
