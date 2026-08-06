/**
 * The nodes the editor knows, and the two Polaris adds to them.
 *
 * `reference` is a mention or a chip: one atom carrying who or what it points
 * at, so it can never be half-deleted into a broken link the way typed text can.
 * `markdownBlock` is the escape hatch - Markdown this schema has no node for is
 * kept as editable source rather than thrown away.
 */

import * as refs from "./references";
import Image from "@tiptap/extension-image";
import StarterKit from "@tiptap/starter-kit";
import { chipClass, chipLabel } from "./chip";
import { Placeholder } from "@tiptap/extensions";
import { mergeAttributes, Node } from "@tiptap/core";
import { MARKDOWN_BLOCK, REFERENCE } from "./markdown";
import { TaskItem, TaskList } from "@tiptap/extension-list";

/**
 * A person, a team, a task, a page or a note, named inline.
 *
 * An atom on purpose: a mention that can be edited character by character stops
 * matching whoever it names, and the person is still notified. Deleting it takes
 * the whole thing, which is the only edit that keeps the text honest.
 */
export const Reference = Node.create({
    name: REFERENCE,
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,
    draggable: true,

    addAttributes() {
        return {
            kind: { default: null },
            id: { default: null },
            label: { default: "" }
        };
    },

    parseHTML() {
        return [{ tag: "span[data-reference]" }];
    },

    renderHTML({ node, HTMLAttributes }) {
        const kind = node.attrs.kind as refs.ReferenceKind;
        const href = refs.referenceHref(kind, String(node.attrs.id ?? ""));
        return [
            "span",
            mergeAttributes(HTMLAttributes, {
                "data-reference": kind,
                "data-id": node.attrs.id,
                title: href ?? undefined,
                class: chipClass(kind)
            }),
            chipLabel(kind, String(node.attrs.label ?? ""))
        ];
    },

    /** What lands on the clipboard, and what a plain-text export reads. */
    renderText({ node }) {
        return chipLabel(node.attrs.kind as refs.ReferenceKind, String(node.attrs.label ?? ""));
    }
});

/** Markdown this schema cannot draw, kept as source somebody can still edit. */
export const MarkdownBlock = Node.create({
    name: MARKDOWN_BLOCK,
    group: "block",
    content: "text*",
    marks: "",
    code: true,
    defining: true,

    parseHTML() {
        return [{ tag: "pre[data-markdown]", preserveWhitespace: "full" }];
    },

    renderHTML({ HTMLAttributes }) {
        return ["pre", mergeAttributes(HTMLAttributes, { "data-markdown": "" }), ["code", 0]];
    }
});

/**
 * The extension set every Polaris editor runs.
 *
 * Headings stop at three: this is a description or a note, and a document that
 * needs six levels needs a page instead. Links never open on click while the
 * caret is in them, because clicking a link you are editing is how you lose what
 * you were typing.
 */
export function baseExtensions(placeholder: string) {
    return [
        // Everything visual is left to the shared type styles the surface
        // carries, so a heading is the same size here as it is once saved.
        StarterKit.configure({
            heading: { levels: [1, 2, 3] },
            link: {
                openOnClick: false,
                autolink: true,
                linkOnPaste: true,
                HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" }
            }
        }),
        Placeholder.configure({ placeholder }),
        TaskList,
        TaskItem.configure({ nested: true, HTMLAttributes: { class: "flex items-start gap-2" } }),
        Image,
        Reference,
        MarkdownBlock
    ];
}
