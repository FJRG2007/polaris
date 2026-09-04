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
import { Link } from "@tiptap/extension-link";
import { chipClass, chipLabel } from "./chip";
import { Placeholder } from "@tiptap/extensions";
import { mergeAttributes, Node } from "@tiptap/core";
import { EditorCodeBlock } from "./editor-code-block";
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
 * A link that ends where the address does.
 *
 * The stock mark declares itself inclusive whenever autolink is on, which means
 * the caret resting at the end of one carries the link into whatever is typed
 * next: paste an address, press space, keep writing, and the sentence is part of
 * the link. Non-inclusive, a space is where the URL stopped and the words after
 * it are words - which is also the honest reading, since nothing re-points the
 * href at the longer text.
 */
const BoundedLink = Link.extend({ inclusive: () => false });

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
        // Links come from `BoundedLink` instead, and code blocks from
        // `EditorCodeBlock` - which is StarterKit's with a language picker and
        // colour on it - so StarterKit's own copies are turned off rather than
        // registered twice.
        StarterKit.configure({
            heading: { levels: [1, 2, 3] },
            link: false,
            codeBlock: false
        }),
        EditorCodeBlock,
        BoundedLink.configure({
            openOnClick: false,
            autolink: true,
            linkOnPaste: true,
            // The same allowlist the renderer applies, applied at the other end:
            // a pasted `javascript:` link would otherwise be a live link to
            // whoever is writing, which is the self-XSS half of the problem.
            // The renderer refuses it either way - this stops it being stored.
            protocols: ["http", "https", "mailto"],
            HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" }
        }),
        Placeholder.configure({ placeholder }),
        TaskList,
        TaskItem.configure({ nested: true, HTMLAttributes: { class: "flex items-start gap-2" } }),
        Image,
        Reference,
        MarkdownBlock
    ];
}
