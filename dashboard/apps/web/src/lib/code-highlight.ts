/**
 * Lazy syntax highlighting, shared by the Drive code viewer, the Markdown
 * fences, and every JSON document the dashboard shows.
 * highlight.js and each grammar are dynamically imported, so nothing reaches the
 * main bundle and a language only loads when a file (or a fence) asks for it.
 *
 * Loading is async but highlighting is not: callers await the grammars once and
 * then hold a synchronous highlighter, which is what lets the editor re-paint on
 * every keystroke. The returned HTML is highlight.js' own - it escapes the source
 * it is given, so the only markup in it is the `span` elements it adds.
 */

import { useEffect, useState } from "react";
import type { HLJSApi } from "highlight.js";
import { languageForToken, type CodeLanguage } from "@/lib/code-language";

/**
 * Highlighting is skipped past this many characters. Tokenizing a file this big
 * costs more than the color is worth, and in the editor it would be paid again
 * on every keystroke.
 */
export const HIGHLIGHT_LIMIT = 200_000;

/** Highlights one snippet to HTML, or returns null when it cannot. */
export type Highlighter = (code: string, token: string) => string | null;

let core: Promise<HLJSApi> | null = null;
const grammars = new Map<string, Promise<boolean>>();

/** The same two, once they have arrived, for the callers that cannot await -
 *  see `highlightIfReady` at the foot of this file. Not a second cache: these
 *  are written as the promises above resolve and read nowhere else. */
let loadedCore: HLJSApi | null = null;
const loaded = new Set<string>();
/** Every grammar whose load has finished, however it finished. A chunk that
 *  failed must stop being asked for, or a caller that redraws when one lands
 *  redraws for ever. */
const settled = new Set<string>();

function loadCore(): Promise<HLJSApi> {
    core ??= import("highlight.js/lib/core").then((module) => {
        loadedCore = module.default;
        return module.default;
    });
    return core;
}

/** Loads and registers one grammar, once. Resolves false when its chunk fails. */
function loadGrammar(language: CodeLanguage): Promise<boolean> {
    const started = grammars.get(language.id);
    if (started) return started;
    const loading = Promise.all([loadCore(), language.load()])
        .then(([hljs, grammar]) => {
            hljs.registerLanguage(language.id, grammar.default);
            loaded.add(language.id);
            settled.add(language.id);
            return true;
        })
        .catch(() => {
            settled.add(language.id);
            return false;
        });
    grammars.set(language.id, loading);
    return loading;
}

/**
 * Loads the grammars behind `tokens` (extensions or Markdown fence tags) and
 * returns a highlighter for them. Anything else it is later asked to highlight
 * comes back null, and the caller shows the code unhighlighted.
 */
export async function loadHighlighter(tokens: Iterable<string>): Promise<Highlighter> {
    const wanted = new Map<string, CodeLanguage>();
    for (const token of tokens) {
        const language = languageForToken(token);
        if (language) wanted.set(language.id, language);
    }
    if (wanted.size === 0) return () => null;
    const hljs = await loadCore();
    const ready = new Set<string>();
    await Promise.all(
        [...wanted.values()].map(async (language) => {
            if (await loadGrammar(language)) ready.add(language.id);
        })
    );
    return (code, token) => {
        const language = languageForToken(token);
        if (!language || !ready.has(language.id) || code.length > HIGHLIGHT_LIMIT) return null;
        return hljs.highlight(code, { language: language.id, ignoreIllegals: true }).value;
    };
}

/** The highlighter for a single language, from the moment its grammar is ready. */
export function useHighlighter(token: string | null): Highlighter | null {
    const [highlighter, setHighlighter] = useState<Highlighter | null>(null);

    useEffect(() => {
        if (token === null) {
            setHighlighter(null);
            return;
        }
        let alive = true;
        void loadHighlighter([token]).then((ready) => {
            // Stored behind an updater: a function in state is otherwise called.
            if (alive) setHighlighter(() => ready);
        });
        return () => {
            alive = false;
        };
    }, [token]);

    return highlighter;
}
// ---------------------------------------------------------------------------
// Highlighting something that is being edited
// ---------------------------------------------------------------------------

/**
 * The same highlighting, for a caller that cannot await.
 *
 * A ProseMirror plugin redraws inside a transaction: there is no point at which
 * it may wait for a grammar to arrive. So these two split the job the hook does
 * in one - ask whether a grammar is here yet and colour with it, or start
 * fetching it and be told when to redraw.
 *
 * Everything they need is already loaded by the pair above; this adds a way to
 * read that state synchronously, not a second cache.
 */

/** Colour a snippet with a grammar that is already loaded, or null. Nothing is
 *  fetched: a redraw that had to fetch would be a redraw that blocks. */
export function highlightIfReady(code: string, token: string): string | null {
    const language = languageForToken(token);
    if (!language || !loadedCore || !loaded.has(language.id)) return null;
    if (code.length > HIGHLIGHT_LIMIT) return null;
    return loadedCore.highlight(code, { language: language.id, ignoreIllegals: true }).value;
}

/**
 * Make sure a grammar is on its way, and say when it lands.
 *
 * Null when there is nothing to wait for - the token names no grammar we have,
 * or that grammar has already finished loading, or finished failing - which is
 * what lets a caller tell "redraw later" from "this is as good as it gets".
 */
export function ensureGrammar(token: string): Promise<boolean> | null {
    const language = languageForToken(token);
    if (!language || settled.has(language.id)) return null;
    return Promise.all([loadCore(), loadGrammar(language)]).then(([, ok]) => ok);
}
