/**
 * Changing the words in a .pptx, and keeping everything else.
 *
 * Drive could read a presentation faithfully and not touch it. This is the other
 * half, and it is deliberately the smallest half that is worth having: the text
 * of a box on a slide. That is what people actually open a deck to change - a
 * date, a name, a number that moved - and it is the change that a converter
 * ruins, because every tool that "edits" a .pptx by rebuilding it throws away
 * the master, the layout, the animations and the fonts on the way through.
 *
 * Nothing is rebuilt here. `@polaris/pptx` keeps every element's original bytes
 * and re-emits only the ones marked changed, patching the runs inside the XML
 * that was already there - so a deck saved with one word altered is the original
 * file with one word altered, and a deck saved with no changes at all is
 * byte-for-byte the file that arrived. Both are tested, and the second is the one
 * that proves the first.
 *
 * **There is no editing session.** The browser holds the deck it already
 * downloaded and sends it back with the change; this parses, patches and answers
 * with the new bytes. That costs a parse per save, which is a fraction of a
 * second and happens when somebody presses a button - and it buys the thing that
 * matters more: no state on the server to expire, evict, or lose when Polaris
 * restarts or runs as more than one instance.
 */

import { openPptx, savePptx } from "@polaris/pptx";

/** One box on one slide, and what it should say. */
export interface TextEdit {
    /** Which page, zero-based, as the renderer numbered them. */
    readonly slideIndex: number;
    /**
     * Which element of that page, by position.
     *
     * Deliberately not the id the renderer drew it with. `openPptx` numbers what
     * it finds from a counter that lives as long as the process, so the same
     * shape in the same file is `sp_0` on one parse and `sp_1` on the next -
     * and this is a different parse from the one the browser is looking at, by
     * definition. A position is a property of the file rather than of the
     * reading, so it still means the same box. `renderPptxDeck` hands out the
     * mapping in `places`.
     */
    readonly elementIndex: number;
    /** What the box should say. A newline starts a new paragraph, which is what
     *  it means in a text box. */
    readonly text: string;
}

/** As large a presentation as this will open. The parse is the expensive part
 *  and it happens before anything can judge the file unreasonable. */
export const MOST_DECK_BYTES = 80 * 1024 * 1024;

export class DeckEditError extends Error {}

/**
 * Apply text changes and answer with the new file.
 *
 * Refuses rather than half-applying: an edit naming a slide or an element that is
 * not there means the browser is working from a deck that is not this one, and
 * writing the rest of the changes would leave a file neither side expected.
 */
export async function editPptxText(
    bytes: Uint8Array,
    edits: readonly TextEdit[]
): Promise<Uint8Array> {
    if (bytes.byteLength > MOST_DECK_BYTES) throw new DeckEditError("This presentation is too large");
    const opened = await openPptx(bytes);

    for (const edit of edits) {
        const slide = opened.deck.slides[edit.slideIndex];
        if (!slide) throw new DeckEditError("That page is not in this presentation");

        const element = (slide.elements as TextLike[])[edit.elementIndex];
        if (!element) throw new DeckEditError("That box is not on this page");
        if (element.type !== "text" && element.type !== "shape") {
            throw new DeckEditError("That is not a box with words in it");
        }

        setText(element, edit.text);
    }

    return savePptx(opened);
}

/** Just enough of the model to write words into it. */
interface TextLike {
    id: string;
    type: string;
    dirty?: boolean;
    text?: { paragraphs: { runs: { text: string }[] }[] };
}

/**
 * Write the words in, keeping the formatting they are wearing.
 *
 * The first run of each paragraph keeps its own styling and takes the new line;
 * the rest are emptied rather than removed, because a run carries its size,
 * weight and colour and dropping it would silently reformat the box. A paragraph
 * beyond what the box already had reuses the last one's shape, which is what
 * pressing Enter at the end of a text box does in PowerPoint too.
 *
 * A box with no text body at all is refused: there is no run to inherit from, so
 * anything written would be in a font this code chose, and choosing a font on
 * somebody's slide is not this function's business.
 */
function setText(element: TextLike, text: string): void {
    const body = element.text;
    if (!body || body.paragraphs.length === 0) {
        throw new DeckEditError("That box has no text to change");
    }

    const lines = text.split("\n");
    const shape = body.paragraphs[body.paragraphs.length - 1]!;

    for (const [index, line] of lines.entries()) {
        const paragraph = body.paragraphs[index] ?? clone(shape);
        if (!body.paragraphs[index]) body.paragraphs.push(paragraph);
        if (paragraph.runs.length === 0) throw new DeckEditError("That box has no text to change");
        paragraph.runs[0]!.text = line;
        // Emptied, not dropped: the run holds the formatting, and a save patches
        // each one in place against the XML it came from.
        for (const run of paragraph.runs.slice(1)) run.text = "";
    }

    // Paragraphs the new text no longer needs are emptied for the same reason.
    for (const paragraph of body.paragraphs.slice(lines.length)) {
        for (const run of paragraph.runs) run.text = "";
    }

    element.dirty = true;
}

/** A paragraph's shape without its words, for a line the box did not have. */
function clone(paragraph: { runs: { text: string }[] }): { runs: { text: string }[] } {
    return {
        ...paragraph,
        runs: paragraph.runs.map((run) => ({ ...run, text: "" }))
    };
}
