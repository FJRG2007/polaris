/**
 * How a mention and a Polaris reference are drawn.
 *
 * Its own module, and a deliberately tiny one: the editor builds a chip out of
 * DOM and the reader builds one out of React, and if they did not share these
 * two functions the same mention would look like two different things. Kept
 * clear of the editor's schema so that reading text never drags ProseMirror in.
 */

import * as refs from "./references";

/** The shape of a chip, whichever side draws it. */
export const CHIP_CLASS =
    "inline-flex max-w-[16rem] items-center gap-1 truncate rounded px-1 py-0.5 align-baseline text-[0.9em] font-medium";

/** A mention of somebody reads as an address; a reference reads as the thing. */
export function chipClass(kind: refs.ReferenceKind): string {
    const tone = refs.MENTION_KINDS.includes(kind)
        ? "bg-primary/15 text-primary"
        : "bg-muted text-foreground ring-1 ring-inset ring-border";
    return `${CHIP_CLASS} ${tone}`;
}

/**
 * What a chip is called when nothing better is known.
 *
 * A pasted address carries no name - the label a fold produces is the URL
 * itself - and a chip reading `#https://polaris.example/chat/c/0193...` is worse
 * than the link it replaced. Whoever resolves the reference replaces this with
 * the real name; this is what is drawn until then, and on the screens that
 * resolve nothing.
 */
const UNNAMED: Partial<Record<refs.ReferenceKind, string>> = {
    channel: "Conversation",
    message: "Message",
    task: "Task",
    doc: "Document",
    note: "Note"
};

/** What a chip says: an @ for a person or a team, the name alone otherwise. */
export function chipLabel(kind: refs.ReferenceKind, label: string): string {
    const named =
        /^https?:\/\//i.test(label.trim()) || !label.trim() ? (UNNAMED[kind] ?? label) : label;
    return `${refs.referenceSigil(kind)}${named}`;
}
