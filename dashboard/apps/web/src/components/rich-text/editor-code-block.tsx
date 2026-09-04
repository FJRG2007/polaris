"use client";

/**
 * A code block while it is being written.
 *
 * Two things were missing and they are the same thing. A fence typed into a note
 * had no way to say which language it was, so it was never coloured - and a
 * fence pasted with a language was coloured once it was read back and never
 * while it was being written. So the block gets the chrome its read-only twin
 * has: the language, chosen from a list, and colour that follows what is typed.
 *
 * The colour is decorations rather than markup. The text in a code block belongs
 * to the document - it is what gets saved, and what the caret moves through - so
 * nothing here may replace it. Highlight.js is asked for its HTML, that HTML is
 * walked for where each of its spans starts and stops, and those become inline
 * decorations over the text that is already there. The document is untouched; a
 * grammar that never loads costs nothing but grey.
 *
 * Grammars arrive late, the way they do everywhere else in Polaris: one chunk
 * per language, fetched when a block asks for it, and a redraw when it lands.
 */

import { useMemo } from "react";
import { Select } from "@polaris/ui";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { CodeBlock } from "@tiptap/extension-code-block";
import type { Node as ProseNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { CODE_LANGUAGES, languageForToken } from "@/lib/code-language";
import { ensureGrammar, highlightIfReady } from "@/lib/code-highlight";
import {
    NodeViewContent,
    NodeViewWrapper,
    ReactNodeViewRenderer,
    type NodeViewProps
} from "@tiptap/react";

/** What the picker offers, once. Every grammar Polaris carries, plus the honest
 *  first entry: a block that is not any of them. */
const OPTIONS = [
    { value: "", label: "Plain text" },
    ...CODE_LANGUAGES.map((language) => ({ value: language.id, label: language.label }))
];

const key = new PluginKey("polaris-code-highlight");

/**
 * Where each of highlight.js' spans falls in the document.
 *
 * The HTML it returns has the source escaped inside it and nothing else, so its
 * text content is the source character for character - which is what makes
 * counting through it a safe way to find positions. Nothing here is inserted
 * into the page; the classes ride on decorations over text the document already
 * holds.
 */
function decorationsFrom(html: string, base: number): Decoration[] {
    const found: Decoration[] = [];
    const template = document.createElement("template");
    template.innerHTML = html;

    let at = base;
    const walk = (node: Node, inherited: string): void => {
        if (node.nodeType === Node.TEXT_NODE) {
            const length = node.nodeValue?.length ?? 0;
            if (length > 0 && inherited) {
                found.push(Decoration.inline(at, at + length, { class: inherited }));
            }
            at += length;
            return;
        }
        const own = node instanceof Element ? (node.getAttribute("class") ?? "") : "";
        const classes = [inherited, own].filter(Boolean).join(" ");
        for (const child of [...node.childNodes]) walk(child, classes);
    };
    for (const child of [...template.content.childNodes]) walk(child, "");
    return found;
}

/**
 * Every code block in the document, coloured with the grammars that are here.
 *
 * The ones that are not are fetched, and `onLoad` is called when they land so
 * the caller can ask for this again. Asking twice for a grammar is free - the
 * loader holds one promise per language.
 */
function highlightDoc(doc: ProseNode, onLoad: () => void): DecorationSet {
    const found: Decoration[] = [];
    const waiting: Promise<boolean>[] = [];

    doc.descendants((node, pos) => {
        if (node.type.name !== "codeBlock") return;
        const token = typeof node.attrs.language === "string" ? node.attrs.language : "";
        if (!token) return;

        const code = node.textContent;
        const marked = highlightIfReady(code, token);
        if (marked === null) {
            const loading = ensureGrammar(token);
            if (loading) waiting.push(loading);
            return;
        }
        // +1 for the block's own opening position: its text starts inside it.
        found.push(...decorationsFrom(marked, pos + 1));
    });

    if (waiting.length > 0) void Promise.all(waiting).then(onLoad);
    return DecorationSet.create(doc, found);
}

/**
 * The colour, as a plugin.
 *
 * Recomputed when the document changes, when a block's language changes, and
 * when a grammar arrives - and not otherwise, which is what keeps typing in a
 * long note from re-tokenizing every fence in it on every keystroke.
 */
function highlightPlugin(): Plugin {
    // Set once the editor has a view, which is after the first state is built -
    // so the redraw a grammar asks for goes through a holder rather than being
    // captured at a point where there is nothing to dispatch to yet.
    const pending = { redraw: () => {} };

    return new Plugin({
        key,
        state: {
            init: (_config, state: EditorState) => highlightDoc(state.doc, () => pending.redraw()),
            apply(transaction: Transaction, value: DecorationSet, _old, state) {
                // The flag is the one a landed grammar sets: nothing in the
                // document changed, and the colour still has to be worked out
                // again. Everything else just moves what is already there, which
                // is what keeps typing in a long note from re-reading every fence
                // in it on every keystroke.
                const asked = transaction.getMeta(key) === true;
                if (!transaction.docChanged && !asked) {
                    return value.map(transaction.mapping, transaction.doc);
                }
                return highlightDoc(state.doc, () => pending.redraw());
            }
        },
        props: {
            decorations(state) {
                return key.getState(state) as DecorationSet;
            }
        },
        view(view) {
            let alive = true;
            // An empty transaction carrying the plugin's own flag, so a redraw
            // touches nothing about the document and nothing about the caret.
            pending.redraw = () => {
                if (alive) view.dispatch(view.state.tr.setMeta(key, true));
            };
            return {
                destroy() {
                    alive = false;
                }
            };
        }
    });
}

/** The header: what this block is, and a way to say something else. */
function CodeBlockShell({ node, updateAttributes, editor }: NodeViewProps) {
    const token = typeof node.attrs.language === "string" ? node.attrs.language : "";
    // A fence tag is whatever was typed - "sh", "golang", "c++" - so the picker
    // shows the grammar it resolves to rather than the word, and an unknown one
    // reads as plain text instead of as a missing option.
    const value = useMemo(() => (token ? (languageForToken(token)?.id ?? "") : ""), [token]);

    return (
        <NodeViewWrapper
            data-code=""
            className="group/code my-1 overflow-hidden rounded-md border border-border bg-muted"
        >
            <div
                contentEditable={false}
                className="flex items-center justify-between gap-2 border-b border-border px-2 py-1"
            >
                <Select
                    value={value}
                    disabled={!editor.isEditable}
                    aria-label="Language of this code"
                    onValueChange={(next) => updateAttributes({ language: next || null })}
                    className="h-6 w-40 border-none bg-transparent px-1 text-[0.625rem] uppercase tracking-[0.06em]"
                    contentClassName="max-h-72"
                    options={OPTIONS}
                />
            </div>
            <pre data-code="" className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">
                <NodeViewContent<"code"> as="code" className="hljs bg-transparent p-0" />
            </pre>
        </NodeViewWrapper>
    );
}

/**
 * The block itself.
 *
 * StarterKit's, with the two things added: somewhere to choose the language, and
 * the colour that choice is for. The node and its attributes are unchanged, so
 * what is stored is the same fence it always was and a note written before this
 * existed opens exactly as it did.
 */
export const EditorCodeBlock = CodeBlock.extend({
    addNodeView() {
        return ReactNodeViewRenderer(CodeBlockShell);
    },
    addProseMirrorPlugins() {
        return [highlightPlugin()];
    }
});
