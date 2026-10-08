/**
 * Markdown shortcuts that also work from a dead key.
 *
 * On a Spanish keyboard - and French, German, Portuguese and others - the
 * backtick, the tilde and the caret are dead keys: pressing one opens a
 * composition, and the next key commits it. Text that arrives that way never
 * reaches the editor as a typed character, so the rule that turns `this` into
 * code never sees the closing backtick. The editor's own retry runs too early,
 * while the composition is still being closed, and gives up. The message was
 * then stored with its backticks escaped and drawn as literal text - the one
 * place a Spanish keyboard and an English one disagreed about what was sent.
 *
 * So once a composition has really ended, the character it committed is offered
 * to the input rules again, exactly as if it had been typed there. Where it sits
 * is followed through whatever is typed in the meantime, so a fast next key does
 * not lose it, and nothing happens when no rule wants it.
 */

import { Extension } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/** The characters a Markdown shortcut can end on and a dead key can produce. */
const CLOSERS = new Set(["`", "~", "^"]);

/** How often to look for the composition to have finished closing, and for how
 *  long. ProseMirror ends it on a short timer of its own after the event. */
const POLL_MS = 25;
const MAX_POLLS = 8;

/** Where the last composition ended, mapped through every edit since, or null. */
const composedKey = new PluginKey<number | null>("composedShortcuts");

function offerComposed(view: EditorView, attempt = 0): void {
    if (view.isDestroyed) return;
    if (view.composing) {
        if (attempt < MAX_POLLS) window.setTimeout(() => offerComposed(view, attempt + 1), POLL_MS);
        return;
    }
    flushComposed(view);
}

/** Apply what the last composition left, once the editor has closed it. */
function flushComposed(view: EditorView): void {
    if (view.isDestroyed) return;
    const at = composedKey.getState(view.state);
    if (at === null || at === undefined || at < 1) return;
    view.dispatch(view.state.tr.setMeta(composedKey, null));
    const committed = view.state.doc.textBetween(at - 1, at);
    if (!CLOSERS.has(committed)) return;
    view.someProp("handleTextInput", (handle) =>
        handle(view, at - 1, at, committed, () => view.state.tr)
    );
}

/**
 * Run `then` once the last composition is closed and its shortcut applied.
 *
 * Sending goes through this, so Enter pressed straight after a dead key sends
 * `this` as code instead of beating the retry and sending the backticks. With
 * no composition in the way - nearly always - it runs at once.
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
                key: composedKey,
                state: {
                    init: () => null,
                    apply(tr, value) {
                        const set = tr.getMeta(composedKey) as number | null | undefined;
                        if (set !== undefined) return set;
                        return value === null ? null : tr.mapping.map(value, -1);
                    }
                },
                props: {
                    handleDOMEvents: {
                        compositionend: (view) => {
                            view.dispatch(
                                view.state.tr.setMeta(composedKey, view.state.selection.from)
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
