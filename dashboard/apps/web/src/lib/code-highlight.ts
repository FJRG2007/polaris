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

function loadCore(): Promise<HLJSApi> {
    core ??= import("highlight.js/lib/core").then((module) => module.default);
    return core;
}

/** Loads and registers one grammar, once. Resolves false when its chunk fails. */
function loadGrammar(language: CodeLanguage): Promise<boolean> {
    const started = grammars.get(language.id);
    if (started) return started;
    const loading = Promise.all([loadCore(), language.load()])
        .then(([hljs, grammar]) => {
            hljs.registerLanguage(language.id, grammar.default);
            return true;
        })
        .catch(() => false);
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
