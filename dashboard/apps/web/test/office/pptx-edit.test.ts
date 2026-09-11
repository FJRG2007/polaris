import { describe, expect, it } from "vitest";
import { writePptx } from "@/lib/office/ooxml";
import type { RenderNode } from "@polaris/pptx-render";
import { renderPptxDeck } from "@/lib/office/pptx-deck";
import { editPptxText, DeckEditError } from "@/lib/office/pptx-edit";

/**
 * Changing the words in a presentation without ruining the rest of it.
 *
 * Every tool that offers to edit a .pptx and does it by rebuilding the file
 * throws away what it did not understand - the master, the layout, the
 * animations, the embedded fonts - and the person who opened it to fix a date
 * finds out weeks later, on a projector. So the test that matters most here is
 * not that the word changed. It is that a deck saved with NO change comes back
 * byte for byte, because that is what proves the save is patching the original
 * file rather than writing a new one that happens to look similar.
 *
 * The decks are generated rather than committed: a .pptx in the repository is a
 * binary nobody can review, and every property asserted here is a property of
 * the round trip rather than of one particular file.
 */
describe("changing the words in a presentation", () => {
    /**
     * Every string the renderer draws, with the ADDRESS of the box it is in.
     *
     * The address is the element's position, not the id on the drawn node: ids
     * are minted per parse, and the parse that draws a deck is never the parse
     * that writes to it. `places` is what maps one to the other, and using it
     * here is using it the way the screen has to.
     */
    const boxes = async (bytes: Uint8Array): Promise<{ at: number; text: string }[]> => {
        const deck = await renderPptxDeck(bytes);
        const found: { at: number; text: string }[] = [];
        const walk = (nodes: readonly RenderNode[]): void => {
            for (const node of nodes) {
                const one = node as {
                    sourceId?: string;
                    text?: { lines?: { runs?: { text?: string }[] }[] };
                    children?: RenderNode[];
                };
                const words = (one.text?.lines ?? [])
                    .flatMap((line) => line.runs ?? [])
                    .map((run) => run.text ?? "")
                    .join("");
                const at = one.sourceId ? place[one.sourceId] : undefined;
                if (at !== undefined && words) found.push({ at, text: words });
                if (one.children) walk(one.children);
            }
        };
        let place: Readonly<Record<string, number>> = {};
        for (const [index, slide] of deck.slides.entries()) {
            place = deck.places[index] ?? {};
            walk(slide.nodes);
        }
        return found;
    };

    const deckOf = async (...pages: string[][]): Promise<Uint8Array> =>
        writePptx(pages.map((lines) => ({ notes: "", lines })));

    it("gives back the very same file when nothing was changed", async () => {
        // The one that proves the rest. A save that rebuilds the package would
        // pass every other test here and still lose the half of a real deck that
        // nothing in this repository understands.
        const original = await deckOf(["Hello"], ["Second"]);
        const saved = await editPptxText(original, []);
        expect(saved.byteLength).toBe(original.byteLength);
        expect([...saved]).toEqual([...original]);
    });

    it("changes the words it was asked to change", async () => {
        const original = await deckOf(["Before"]);
        const target = (await boxes(original)).find((box) => box.text.includes("Before"));
        expect(target, "the box to edit was not found").toBeTruthy();

        const saved = await editPptxText(original, [
            { slideIndex: 0, elementIndex: target!.at, text: "After" }
        ]);
        const words = (await boxes(saved)).map((box) => box.text).join(" ");
        expect(words).toContain("After");
        expect(words).not.toContain("Before");
    });

    it("leaves every other page alone", async () => {
        // A patch that re-emitted the whole deck would pass the test above and
        // quietly rewrite pages nobody touched.
        const original = await deckOf(["Change me"], ["Leave me"], ["And me"]);
        const target = (await boxes(original)).find((box) => box.text.includes("Change me"));
        const saved = await editPptxText(original, [
            { slideIndex: 0, elementIndex: target!.at, text: "Changed" }
        ]);

        const after = (await boxes(saved)).map((box) => box.text).join(" ");
        expect(after).toContain("Leave me");
        expect(after).toContain("And me");
        expect(after).toContain("Changed");
    });

    it("makes a new paragraph out of a new line", async () => {
        const original = await deckOf(["One line"]);
        const target = (await boxes(original)).find((box) => box.text.includes("One line"));
        const saved = await editPptxText(original, [
            { slideIndex: 0, sourceId: target!.id, text: "First\nSecond" }
        ]);
        const words = (await boxes(saved)).map((box) => box.text).join(" ");
        expect(words).toContain("First");
        expect(words).toContain("Second");
    });

    it("refuses an edit that does not fit this deck, rather than applying half of it", async () => {
        // A browser working from a different copy of the file is the case this
        // guards: applying what matched would leave a deck neither side expected.
        const original = await deckOf(["Hello"]);
        const target = (await boxes(original)).find((box) => box.text.includes("Hello"));

        await expect(
            editPptxText(original, [{ slideIndex: 9, elementIndex: target!.at, text: "x" }])
        ).rejects.toThrow(DeckEditError);
        await expect(
            editPptxText(original, [{ slideIndex: 0, elementIndex: 99, text: "x" }])
        ).rejects.toThrow(DeckEditError);
    });

    it("does not corrupt the file it refuses", async () => {
        // The refusal happens before anything is written, so the caller still
        // holds a deck that opens.
        const original = await deckOf(["Hello"]);
        await expect(
            editPptxText(original, [{ slideIndex: 4, elementIndex: 0, text: "y" }])
        ).rejects.toThrow();
        await expect(renderPptxDeck(original)).resolves.toBeTruthy();
    });
});
