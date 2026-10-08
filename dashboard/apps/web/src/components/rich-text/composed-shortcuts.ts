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
 *
 * A pair is also settled when it is written the other way round: pressing the
 * dead key twice gives both backticks at once, so the natural thing is to step
 * back between them and type the word - which never types a closing character
 * at all. Typing inside a pair, or typing its opening in front of one already
 * closed, turns it into the mark too, and the caret stays inside it.
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

/** The pairs settled here: the text that opens and closes each, and whether its
 *  opening needs a space or the start of the line before it. Both mirror the
 *  editor's own rules. */
const PAIRS: ReadonlyArray<{ mark: string; token: string; spaceBefore: boolean }> = [
    { mark: "code", token: "`", spaceBefore: false },
    { mark: "strike", token: "~~", spaceBefore: true }
];

/** Where a typed range sits, and whether only a pair closed exactly at its end
 *  counts - what a settle after a composition asks for. */
interface Typed {
    readonly from: number;
    readonly to: number;
    readonly closingOnly: boolean;
}

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
function typedRanges(transactions: readonly Transaction[], before: EditorState): Typed[] {
    const ranges: Typed[] = [];
    transactions.forEach((tr, index) => {
        const requested = tr.getMeta(settleKey) as number[] | number | null | undefined;
        if (Array.isArray(requested))
            for (const at of requested) {
                const mapped = mapOn(transactions, index + 1, at);
                ranges.push({ from: mapped, to: mapped, closingOnly: true });
            }
        if (!typed(tr) || (index === 0 && undoesInputRule(before, tr))) return;
        tr.steps.forEach((step, stepIndex) => {
            step.getMap().forEach((_from, _to, start, end) => {
                const size = end - start;
                if (size < 1 || size > 2) return;
                const rest = tr.mapping.slice(stepIndex + 1);
                ranges.push({
                    from: mapOn(transactions, index + 1, rest.map(start, 1)),
                    to: mapOn(transactions, index + 1, rest.map(end, -1)),
                    closingOnly: false
                });
            });
        });
    });
    return ranges;
}

function mapOn(transactions: readonly Transaction[], from: number, at: number): number {
    return transactions.slice(from).reduce((pos, tr) => tr.mapping.map(pos, -1), at);
}

/** Where `token` stands on its own in `text` - not part of a longer run of its
 *  character, which is a different piece of Markdown. */
function loneTokens(text: string, token: string): number[] {
    const char = token[0]!;
    const found: number[] = [];
    for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1))
        if (text[at - 1] !== char && text[at + token.length] !== char) found.push(at);
    return found;
}

/**
 * The pair, as offsets of its opening and closing token, that the text typed at
 * `typed` closes, sits inside, or opens - in that order of preference.
 */
function pairAround(
    text: string,
    pair: (typeof PAIRS)[number],
    typed: Typed
): { open: number; close: number; closed: boolean } | null {
    const width = pair.token.length;
    const tokens = loneTokens(text, pair.token);
    const valid = (open: number, close: number): boolean => {
        if (open < 0 || close <= open) return false;
        const inner = text.slice(open + width, close);
        if (inner.includes(pair.token[0]!) || inner.includes(LEAF) || !/\S/.test(inner))
            return false;
        return !pair.spaceBefore || open === 0 || /\s/.test(text[open - 1]!);
    };
    const before = (at: number) => tokens.filter((token) => token + width <= at).at(-1) ?? -1;
    const after = (at: number) => tokens.find((token) => token >= at) ?? -1;
    const endsToken = tokens.includes(typed.to - width);

    // Closed by what was typed: the nearest opening before it.
    if (endsToken) {
        const close = typed.to - width;
        const open = before(close);
        if (valid(open, close)) return { open, close, closed: true };
    }
    if (typed.closingOnly || typed.to <= typed.from) return null;
    // Typed between the two halves of a pair.
    const open = before(typed.from);
    const close = after(typed.to);
    if (valid(open, close)) return { open, close, closed: false };
    // Typed the opening in front of a pair already closed.
    if (endsToken) {
        const opening = typed.to - width;
        const closing = after(typed.to);
        if (valid(opening, closing)) return { open: opening, close: closing, closed: false };
    }
    return null;
}

/** The transaction that turns the pair typed at `typed` into its mark, if one is. */
function settleAt(state: EditorState, typed: Typed): Transaction | null {
    const { doc } = state;
    if (typed.to < 1 || typed.to > doc.content.size || typed.from > typed.to) return null;
    const $end = doc.resolve(typed.to);
    const block = $end.parent;
    if (!block.isTextblock || block.type.spec.code) return null;
    const start = $end.start();
    if (typed.from < start) return null;
    const text = doc.textBetween(start, $end.end(), undefined, LEAF);
    const local: Typed = { ...typed, from: typed.from - start, to: typed.to - start };

    for (const pair of PAIRS) {
        const type: MarkType | undefined = state.schema.marks[pair.mark];
        const found = type ? pairAround(text, pair, local) : null;
        if (!type || !found) continue;
        const width = pair.token.length;
        const from = start + found.open;
        const end = start + found.close + width;
        // Already formatted - a pair inside code is its content, not a shortcut.
        if (doc.rangeHasMark(from, end, state.schema.marks.code ?? type)) continue;
        const tr = state.tr
            .delete(end - width, end)
            .delete(from, from + width)
            .addMark(from, end - 2 * width, type.create());
        // Typed inside the pair, the caret is in the mark and stays there.
        if (!found.closed) return tr;
        tr.removeStoredMark(type);
        const rules = state.plugins.find((plugin) => plugin.spec.isInputRules);
        if (rules)
            tr.setMeta(rules, { transform: tr, from: end - width, to: end, text: pair.token });
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
                    for (const range of typedRanges(transactions, old)) {
                        const tr = settleAt(state, range);
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
