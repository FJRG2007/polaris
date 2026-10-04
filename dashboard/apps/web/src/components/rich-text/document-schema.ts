/**
 * What a document can say that a comment cannot.
 *
 * A task comment or a note is Markdown underneath, and Markdown has no word for
 * a font, a colour, an alignment or a table cell - so those stay out of the
 * shared set. A document in Office is a Yjs tree that is exported to Word, and
 * Word has a word for every one of them, so this is the shared set plus the
 * formatting a word processor is expected to carry.
 *
 * Every mark and attribute here travels through Yjs like any other: the toolbar
 * only runs editor commands, so two people formatting at once merge the same
 * way two people typing do.
 */

import { Extension, isNodeActive, type CommandProps } from "@tiptap/core";
import { baseExtensions } from "./schema";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Color, FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";

/** The deepest a paragraph indents. Word allows more, and nobody reads a
 *  paragraph that starts in the middle of the page. */
export const MAX_INDENT = 8;

/** One step of indentation, in the editor and in the export alike. Half an inch
 *  is Word's own default tab stop. */
export const INDENT_STEP_REM = 2;

/** What `indent` and `outdent` act on. Headings indent too: a document outline
 *  set in from the margin is a real thing people do. */
const INDENTED = ["paragraph", "heading"] as const;

declare module "@tiptap/core" {
    interface Commands<ReturnType> {
        indent: {
            /** One step further in: a list item is nested, anything else is
             *  moved in from the margin. */
            indent: () => ReturnType;
            /** One step back out. */
            outdent: () => ReturnType;
        };
    }
}

/** Clamp a stored indent to the levels this editor draws. */
export function indentLevel(value: unknown): number {
    const level = Number(value);
    if (!Number.isFinite(level)) return 0;
    return Math.min(MAX_INDENT, Math.max(0, Math.trunc(level)));
}

/**
 * Indentation for paragraphs and headings.
 *
 * Inside a list the list itself is the indentation, so there the commands nest
 * and un-nest the item rather than pushing its text along.
 */
export const Indent = Extension.create({
    name: "indent",

    addGlobalAttributes() {
        return [
            {
                types: [...INDENTED],
                attributes: {
                    indent: {
                        default: 0,
                        parseHTML: (element) => indentLevel(element.getAttribute("data-indent")),
                        renderHTML: (attributes) => {
                            const level = indentLevel(attributes.indent);
                            if (level === 0) return {};
                            return {
                                "data-indent": String(level),
                                style: `margin-left: ${level * INDENT_STEP_REM}rem`
                            };
                        }
                    }
                }
            }
        ];
    },

    addCommands() {
        const shift =
            (by: number) =>
            () =>
            ({ commands, tr, state, dispatch }: CommandProps) => {
                const inTask = isNodeActive(state, "taskItem");
                if (inTask || isNodeActive(state, "listItem")) {
                    const item = inTask ? "taskItem" : "listItem";
                    return by > 0
                        ? commands.sinkListItem(item)
                        : commands.liftListItem(item);
                }
                const { from, to } = state.selection;
                let changed = false;
                state.doc.nodesBetween(from, to, (node, position) => {
                    if (!(INDENTED as readonly string[]).includes(node.type.name)) return;
                    const next = indentLevel(indentLevel(node.attrs.indent) + by);
                    if (next === indentLevel(node.attrs.indent)) return false;
                    tr.setNodeMarkup(position, undefined, { ...node.attrs, indent: next });
                    changed = true;
                    return false;
                });
                if (changed && dispatch) dispatch(tr);
                return changed;
            };
        return { indent: shift(1), outdent: shift(-1) };
    },

    addKeyboardShortcuts() {
        return {
            "Mod-]": () => this.editor.commands.indent(),
            "Mod-[": () => this.editor.commands.outdent()
        };
    }
});

/**
 * The extension set an Office document runs: everything a comment has, and the
 * formatting a document is expected to carry.
 *
 * `history` is off because the document's undo is the CRDT's - see the editor.
 */
export function documentExtensions(placeholder: string) {
    return [
        ...baseExtensions(placeholder, { history: false }),
        TextStyle,
        Color,
        FontFamily,
        FontSize,
        // Any colour rather than the one yellow: a highlight somebody picked
        // to match a colour key has to stay that colour.
        Highlight.configure({ multicolor: true }),
        TextAlign.configure({ types: ["heading", "paragraph"] }),
        Indent,
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell
    ];
}
