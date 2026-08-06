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

/** What a chip says: an @ for a person or a team, the name alone otherwise. */
export function chipLabel(kind: refs.ReferenceKind, label: string): string {
    return `${refs.referenceSigil(kind)}${label}`;
}
