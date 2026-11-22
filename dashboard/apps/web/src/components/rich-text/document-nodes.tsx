"use client";

/**
 * The document blocks the editor writes beyond prose: a formula inside a
 * sentence, a table of contents, and headings that fold their section away.
 *
 * The first two are nodes every editor knows, because the parser produces them
 * from any stored text and an editor that does not know a node drops it on the
 * next save. Folding is a view of the document, not part of it, so it is an
 * extension a surface opts into and nothing about it is stored.
 */

import { useEffect, useState } from "react";
import { Formula, OutlineList } from "./document-blocks";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Extension, InputRule, Node, type Editor } from "@tiptap/core";
import { hiddenBlocks, outlineOf, type OutlineEntry } from "./outline";
import { INLINE_MATH, TABLE_OF_CONTENTS, TABLE_OF_CONTENTS_LINE } from "./markdown";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";

/**
 * A formula the editor shows drawn. Clicking it turns it back into the
 * `$source` it was typed as, caret at the end, so editing it is typing - the
 * closing dollar sign draws it again.
 */
function InlineMathView({ node, editor, getPos }: NodeViewProps) {
    const latex = String(node.attrs.latex ?? "");
    const unwrap = () => {
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (!editor.isEditable || typeof pos !== "number") return;
        const text = `$${latex}`;
        editor
            .chain()
            .focus()
            .command(({ tr }) => {
                tr.replaceWith(pos, pos + node.nodeSize, editor.schema.text(text));
                tr.setSelection(TextSelection.create(tr.doc, pos + text.length));
                return true;
            })
            .run();
    };
    return (
        <NodeViewWrapper as="span" className="cursor-pointer" onClick={unwrap}>
            <Formula latex={latex} />
        </NodeViewWrapper>
    );
}

export const InlineMath = Node.create({
    name: INLINE_MATH,
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,

    addAttributes() {
        return { latex: { default: "" } };
    },
    parseHTML() {
        return [
            {
                tag: "span[data-latex]",
                getAttrs: (element) => ({ latex: element.getAttribute("data-latex") ?? "" })
            }
        ];
    },
    renderHTML({ node }) {
        return ["span", { "data-latex": node.attrs.latex }, `$${node.attrs.latex}$`];
    },
    renderText({ node }) {
        return `$${node.attrs.latex}$`;
    },
    addNodeView() {
        return ReactNodeViewRenderer(InlineMathView);
    },
    addInputRules() {
        // `$x$` typed after a space or at the start of a line. Neither dollar
        // sign may touch a space on its inside, which is what keeps "$5 and $"
        // from being read as a formula.
        return [
            new InputRule({
                find: /(?:^|[\s(])\$([^\s$](?:[^$]*[^\s$])?)\$$/,
                handler: ({ state, range, match }) => {
                    const latex = match[1] ?? "";
                    const start = range.from + (match[0].length - latex.length - 2);
                    state.tr.replaceWith(start, range.to, this.type.create({ latex }));
                }
            })
        ];
    }
});

/** The headings of the document an editor holds, kept current as it changes. */
function useEditorOutline(editor: Editor): OutlineEntry[] {
    const [outline, setOutline] = useState<OutlineEntry[]>(() =>
        outlineOf(editor.getJSON().content)
    );
    useEffect(() => {
        const update = () => setOutline(outlineOf(editor.getJSON().content));
        editor.on("update", update);
        return () => {
            editor.off("update", update);
        };
    }, [editor]);
    return outline;
}

/** Where the top-level block at an index starts. */
function blockPosition(editor: Editor, index: number): number | null {
    let found: number | null = null;
    editor.state.doc.forEach((_child, offset, at) => {
        if (at === index) found = offset;
    });
    return found;
}

function TableOfContentsView({ editor }: NodeViewProps) {
    const outline = useEditorOutline(editor);
    const pick = (entry: OutlineEntry) => {
        const pos = blockPosition(editor, entry.index);
        if (pos === null) return;
        const dom = editor.view.nodeDOM(pos);
        if (dom instanceof HTMLElement) dom.scrollIntoView({ block: "start", behavior: "smooth" });
        editor.chain().focus().setTextSelection(pos + 1).run();
    };
    return (
        <NodeViewWrapper contentEditable={false} className="my-2">
            <OutlineList outline={outline} onPick={pick} />
        </NodeViewWrapper>
    );
}

export const TableOfContents = Node.create({
    name: TABLE_OF_CONTENTS,
    group: "block",
    atom: true,
    selectable: true,
    draggable: true,

    parseHTML() {
        return [{ tag: "div[data-toc]" }];
    },
    renderHTML() {
        return ["div", { "data-toc": "" }, TABLE_OF_CONTENTS_LINE];
    },
    renderText() {
        return TABLE_OF_CONTENTS_LINE;
    },
    addNodeView() {
        return ReactNodeViewRenderer(TableOfContentsView);
    }
});

const foldKey = new PluginKey<ReadonlySet<number>>("polaris-fold-headings");

/**
 * Headings that fold their section away.
 *
 * What is folded is kept as the positions of the folded headings, mapped
 * through every change so a fold stays on its heading while text is typed above
 * it. It lives only as long as the editor: folding is how somebody reads a long
 * note right now, not something the note says.
 */
export const FoldableHeadings = Extension.create<{ say: () => (key: "fold" | "unfold") => string }>({
    name: "polarisFoldableHeadings",

    addOptions() {
        return { say: () => (key) => key };
    },

    addProseMirrorPlugins() {
        const say = this.options.say;
        return [
            new Plugin<ReadonlySet<number>>({
                key: foldKey,
                state: {
                    init: () => new Set<number>(),
                    apply(tr, folded) {
                        const toggle = tr.getMeta(foldKey) as number | undefined;
                        let next = folded;
                        if (tr.docChanged) {
                            next = new Set(
                                [...folded]
                                    .map((pos) => tr.mapping.mapResult(pos))
                                    .filter((result) => !result.deleted)
                                    .map((result) => result.pos)
                                    .filter((pos) => tr.doc.nodeAt(pos)?.type.name === "heading")
                            );
                        }
                        if (typeof toggle === "number") {
                            const copy = new Set(next);
                            if (copy.has(toggle)) copy.delete(toggle);
                            else copy.add(toggle);
                            next = copy;
                        }
                        return next;
                    }
                },
                props: {
                    decorations(state) {
                        const folded = foldKey.getState(state) ?? new Set<number>();
                        const levels: (number | null)[] = [];
                        const starts: number[] = [];
                        const foldedIndices = new Set<number>();
                        state.doc.forEach((child, offset, index) => {
                            starts.push(offset);
                            levels.push(child.type.name === "heading" ? Number(child.attrs.level) : null);
                            if (folded.has(offset)) foldedIndices.add(index);
                        });
                        const hidden = hiddenBlocks(levels, foldedIndices);
                        const found: Decoration[] = [];
                        state.doc.forEach((child, offset, index) => {
                            if (hidden.has(index)) {
                                found.push(Decoration.node(offset, offset + child.nodeSize, { class: "hidden" }));
                            }
                            if (child.type.name !== "heading") return;
                            const isFolded = foldedIndices.has(index);
                            found.push(
                                Decoration.widget(
                                    offset + 1,
                                    () => {
                                        const button = document.createElement("button");
                                        button.type = "button";
                                        button.contentEditable = "false";
                                        button.dataset.fold = String(offset);
                                        button.setAttribute("aria-expanded", String(!isFolded));
                                        button.setAttribute("aria-label", say()(isFolded ? "unfold" : "fold"));
                                        button.title = say()(isFolded ? "unfold" : "fold");
                                        button.textContent = isFolded ? "▸" : "▾";
                                        button.className =
                                            "me-1 inline-flex w-4 select-none justify-center align-middle text-[0.75em] text-muted-foreground opacity-40 hover:opacity-100 focus-visible:opacity-100";
                                        return button;
                                    },
                                    { side: -1, key: `fold-${offset}-${isFolded}`, ignoreSelection: true }
                                )
                            );
                        });
                        return DecorationSet.create(state.doc, found);
                    },
                    handleDOMEvents: {
                        mousedown(view, event) {
                            const target = event.target instanceof Element ? event.target.closest("[data-fold]") : null;
                            if (!(target instanceof HTMLElement)) return false;
                            event.preventDefault();
                            view.dispatch(view.state.tr.setMeta(foldKey, Number(target.dataset.fold)));
                            return true;
                        }
                    }
                }
            })
        ];
    }
});
