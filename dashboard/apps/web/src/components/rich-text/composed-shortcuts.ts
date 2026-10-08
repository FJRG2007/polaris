/**
 * Markdown shortcuts that work however the closing character arrived.
 *
 * On a Spanish keyboard - and French, German, Portuguese and others - the
 * backtick and the tilde are dead keys. Depending on the system and the browser
 * the character they produce arrives as a composition, as a plain insertion the
 * editor's own rules never get to see, or late, after the rule has already
 * looked. Each of those left `this` with its backticks in the text: the message
 * was stored with them escaped and drawn as literal text, while the same words
 * pasted, or typed on an English keyboard, came out as code.
 *
 * So the shortcut is settled from the document rather than from the key event.
 * Whenever a character is typed that closes `code` or ~~strike~~, and the text
 * before it opens the same pair, the pair becomes the mark - exactly what the
 * rule does when it does see the key. A composition is left alone while it is
 * open and settled once it has really ended. Pasting, undoing and loading a
 * document are not typing and are never rewritten.
 */

import { Extension } from "@tiptap/core";
import type { MarkType } from "@tiptap/pm/model";
import type { Transform } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";

/** How often to look for the composition to have finished closing, and for how
 *  long. ProseMirror ends it on a short timer of its own after the event. */
const POLL_MS = 25;
const MAX_POLLS = 8;

/** Stands in for a chip or a line break inside the text that is matched, so a
 *  pair can never reach across one. */
const LEAF = "￼";

/** The pairs settled here: the closing text that triggers each, and what must
 *  come before it in the same paragraph. Both mirror the editor's own rules. */
const PAIRS: ReadonlyArray<{ mark: string; close: string; before: RegExp }> = [
    { mark: "code", close: "`", before: /(?:^|[^`])(`([^`￼]*[^`\s￼][^`￼]*)`)$/ },
    { mark: "strike", close: "~~", before: /(?:^|\s)(~~([^~￼]*[^~\s￼][^~￼]*)~~)$/ }
];

/** Where the last composition ended, followed through every edit since; a
 *  transaction carrying a list of positions asks for those to be settled. */
const settleKey = new PluginKey<number | null>("composedShortcuts");

/** Transactions that are not somebody typing. */
function typed(tr: Transaction): boolean {
    if (!tr.docChanged) return false;
    if (tr.getMeta("composition") !== undefined) return false;
    if (tr.getMeta("history$") !== undefined) return false;
    const event = tr.getMeta("uiEvent") as string | undefined;
    return event !== "paste" && event !== "drop" && !tr.getMeta("paste");
}

/** Whether `tr` takes back the shortcut an input rule just applied in `state` -
 *  what Backspace does straight after one, putting the typed character back. */
function undoesInputRule(state: EditorState, tr: Transaction): boolean {
    return state.plugins.some((plugin) => {
        if (!plugin.spec.isInputRules) return false;
        const done = (plugin.getState(state) as { transform?: Transform } | null | undefined)
            ?.transform;
        if (!done || tr.steps.length <= done.steps.length) return false;
        const undone = done.steps.map((step, index) => step.invert(done.docs[index]!)).reverse();
        return undone.every(
            (step, index) =>
                JSON.stringify(tr.steps[index]?.toJSON()) === JSON.stringify(step.toJSON())
        );
    });
}

/** Where, in the final document, a character or two was just put. */
function typedEnds(transactions: readonly Transaction[], before: EditorState): number[] {
    const ends: number[] = [];
    transactions.forEach((tr, index) => {
        const requested = tr.getMeta(settleKey) as number[] | number | null | undefined;
        if (Array.isArray(requested))
            ends.push(...requested.map((at) => mapOn(transactions, index + 1, at)));
        if (!typed(tr) || (index === 0 && undoesInputRule(before, tr))) return;
        tr.steps.forEach((step, stepIndex) => {
            step.getMap().forEach((_from, _to, start, end) => {
                const size = end - start;
                if (size < 1 || size > 2) return;
                const inTr = tr.mapping.slice(stepIndex + 1).map(end, -1);
                ends.push(mapOn(transactions, index + 1, inTr));
            });
        });
    });
    return ends;
}

function mapOn(transactions: readonly Transaction[], from: number, at: number): number {
    return transactions.slice(from).reduce((pos, tr) => tr.mapping.map(pos, -1), at);
}

/** The transaction that turns a pair closed at `end` into its mark, if one is. */
function settleAt(state: EditorState, end: number): Transaction | null {
    const { doc } = state;
    if (end < 1 || end > doc.content.size) return null;
    const $end = doc.resolve(end);
    const block = $end.parent;
    if (!block.isTextblock || block.type.spec.code) return null;
    const text = doc.textBetween($end.start(), end, undefined, LEAF);

    for (const pair of PAIRS) {
        if (!text.endsWith(pair.close)) continue;
        const type: MarkType | undefined = state.schema.marks[pair.mark];
        const found = pair.before.exec(text);
        const closed = found?.[1];
        if (!type || !closed) continue;
        const from = end - closed.length;
        // Already formatted - a pair inside code is its content, not a shortcut.
        if (doc.rangeHasMark(from, end, state.schema.marks.code ?? type)) continue;
        const width = pair.close.length;
        const tr = state.tr
            .delete(end - width, end)
            .delete(from, from + width)
            .addMark(from, end - 2 * width, type.create())
            .removeStoredMark(type);
        const rules = state.plugins.find((plugin) => plugin.spec.isInputRules);
        if (rules)
            tr.setMeta(rules, { transform: tr, from: end - width, to: end, text: pair.close });
        return tr;
    }
    return null;
}

function offerComposed(view: EditorView, attempt = 0): void {
    if (view.isDestroyed) return;
    if (view.composing) {
        if (attempt < MAX_POLLS) window.setTimeout(() => offerComposed(view, attempt + 1), POLL_MS);
        return;
    }
    flushComposed(view);
}

/**
 * Settle what a composition left, once it has closed.
 *
 * Where it ended was noted when it ended, but the browser may only put the
 * committed text in after that - one character, or two when the dead key was
 * followed by one it does not combine with - and somebody typing fast has moved
 * the caret on by then. So the noted place, the few after it, and the caret are
 * all looked at; only a pair actually closed at one of them changes anything.
 */
function flushComposed(view: EditorView): void {
    if (view.isDestroyed) return;
    const at = settleKey.getState(view.state);
    const head = view.state.selection.head;
    const near = at === null || at === undefined ? [] : [at, at + 1, at + 2];
    view.dispatch(view.state.tr.setMeta(settleKey, [...near, head, head - 1]));
}

/**
 * Run `then` once the last composition is closed and its shortcut applied.
 *
 * Sending goes through this, so Enter pressed straight after a dead key sends
 * `this` as code instead of beating the settling and sending the backticks.
 * With no composition in the way - nearly always - it runs at once.
 */
export function afterComposition(view: EditorView, then: () => void, attempt = 0): void {
    if (view.composing && attempt < MAX_POLLS) {
        window.setTimeout(() => afterComposition(view, then, attempt + 1), POLL_MS);
        return;
    }
    flushComposed(view);
    then();
}

export const ComposedShortcuts = Extension.create({
    name: "composedShortcuts",

    addProseMirrorPlugins() {
        return [
            new Plugin<number | null>({
                key: settleKey,
                state: {
                    init: () => null,
                    apply(tr, value) {
                        const meta = tr.getMeta(settleKey) as number[] | number | null | undefined;
                        if (Array.isArray(meta)) return null;
                        if (meta !== undefined) return meta;
                        return value === null ? null : tr.mapping.map(value, -1);
                    }
                },
                appendTransaction(transactions, old, state) {
                    for (const end of typedEnds(transactions, old)) {
                        const tr = settleAt(state, end);
                        if (tr) return tr;
                    }
                    return null;
                },
                props: {
                    handleDOMEvents: {
                        compositionend: (view) => {
                            view.dispatch(
                                view.state.tr.setMeta(settleKey, view.state.selection.from)
                            );
                            window.setTimeout(() => offerComposed(view), 0);
                            return false;
                        }
                    }
                }
            })
        ];
    }
});
