/**
 * The fields a rewrite left to fill, drawn as boxes.
 *
 * "Improve" writes `{{Recipient's name}}` wherever only the writer knows the
 * value (`lib/polar/improve-draft.ts`). Left as text that is easy to send by
 * mistake, so every one in the document is drawn as a dashed box, and a click
 * on one selects the whole token, so typing replaces it. Decorations only: the
 * document, and the Markdown stored from it, keep the plain braces.
 */

import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { FILL_IN } from "@/lib/polar/improve-draft";

export const FILL_IN_CLASS =
    "rich-text-fill cursor-pointer rounded-sm border border-dashed border-warning-edge bg-warning-soft px-0.5 text-warning-ink";

interface Field {
    from: number;
    to: number;
}

/** Every `{{field}}` in the document, as positions. Pure. */
export function fillInRanges(doc: PmNode): Field[] {
    const ranges: Field[] = [];
    doc.descendants((node, position) => {
        if (!node.isText || !node.text) return;
        for (const match of node.text.matchAll(new RegExp(FILL_IN.source, "g"))) {
            const from = position + (match.index ?? 0);
            ranges.push({ from, to: from + match[0].length });
        }
    });
    return ranges;
}

const key = new PluginKey<DecorationSet>("fillIn");

function decorate(doc: PmNode): DecorationSet {
    return DecorationSet.create(
        doc,
        fillInRanges(doc).map((range) =>
            Decoration.inline(range.from, range.to, {
                class: FILL_IN_CLASS,
                "data-fill-in": ""
            })
        )
    );
}

export const FillIn = Extension.create({
    name: "fillIn",
    addProseMirrorPlugins() {
        return [
            new Plugin<DecorationSet>({
                key,
                state: {
                    init: (_, state) => decorate(state.doc),
                    apply: (tr, old) => (tr.docChanged ? decorate(tr.doc) : old)
                },
                props: {
                    decorations: (state) => key.getState(state),
                    handleClick: (view, position) => {
                        const hit = fillInRanges(view.state.doc).find(
                            (range) => position >= range.from && position <= range.to
                        );
                        if (!hit || !view.editable) return false;
                        view.dispatch(
                            view.state.tr.setSelection(
                                TextSelection.create(view.state.doc, hit.from, hit.to)
                            )
                        );
                        return true;
                    }
                }
            })
        ];
    }
});

/** The first field with this label, as positions, for a caller that reveals it. */
export function findFillIn(doc: PmNode, label: string): Field | null {
    for (const range of fillInRanges(doc)) {
        const text = doc.textBetween(range.from, range.to);
        if (text.slice(2, -2).trim() === label) return range;
    }
    return null;
}
