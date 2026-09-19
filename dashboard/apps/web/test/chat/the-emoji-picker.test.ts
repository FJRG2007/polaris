/**
 * The picker beside the message box, and what it leaves behind.
 *
 * **Opening it was a wait.** Four hundred and fifteen emoji in eight groups,
 * every one of them a button with a label, all built before the panel was
 * painted - and the grids were not memoised, so a letter typed into the search
 * box above them rebuilt all four hundred underneath it. What anybody sees when
 * the panel opens is the top of the list, so that is what is built now; the rest
 * follows on the next frame, as a transition, where it holds nothing up.
 *
 * **And picking one left it in the box after the message was sent.** Clearing
 * the box is a rebuild of the editor - it owns its document, and setting the
 * value prop back to "" does not empty it - so the rebuilt editor was a new
 * instance, its insert effect ran again on mount, and the token still sitting in
 * the composer's hand put the emoji straight back into the box that had just
 * been emptied.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

describe("opening the picker", () => {
    const picker = readFile(`${SRC}app/(app)/chat/emoji-picker.tsx`, "utf8");

    it("builds the top of the list first and the rest after the frame", async () => {
        const source = await picker;
        expect(source).toContain("const FIRST_GROUPS = 2;");
        expect(source).toContain(
            "const groups = restDrawn ? EMOJI_GROUPS : EMOJI_GROUPS.slice(0, FIRST_GROUPS);"
        );
        expect(source).toContain(
            "const frame = requestAnimationFrame(() => startTransition(() => setRestDrawn(true)));"
        );
    });

    it("draws the groups it has decided on rather than all of them", async () => {
        const source = await picker;
        expect(source).toContain("{groups.map((group) => (");
        expect(source).not.toContain("{EMOJI_GROUPS.map((group) => (");
    });

    it("starts from the top again the next time it opens", async () => {
        // Left as it was, a picker closed after scrolling would reopen holding
        // every group, which is the cost this exists to avoid.
        const source = await picker;
        const effect = source.slice(source.indexOf("const [restDrawn, setRestDrawn]"));
        expect(effect.slice(0, effect.indexOf("}, [open]);"))).toContain("setRestDrawn(false);");
    });

    it("does not rebuild every button for a letter typed above them", async () => {
        const source = await picker;
        expect(source).toContain("const Grid = memo(function Grid({");
        // One handler for every grid, or the memo above is defeated by a new
        // function on each render.
        expect(source).toContain("<Grid entries={found} onPick={pick} />");
        expect(source).toContain("<Grid entries={recentEntries} onPick={pick} />");
        expect(source).toContain("<Grid entries={group.emoji} onPick={pick} />");
    });

    it("keeps the recents as a value rather than a fresh array each render", async () => {
        const source = await picker;
        expect(source).toContain("const recentEntries = useMemo(");
    });
});

describe("sending what was picked", () => {
    const composer = readFile(`${SRC}app/(app)/chat/composer.tsx`, "utf8");

    it("forgets what was handed in when the box is emptied", async () => {
        const source = await composer;
        const empty = source.slice(source.indexOf("const emptyTheBox = useCallback"));
        const body = empty.slice(0, empty.indexOf("}, []);"));
        expect(body).toContain("setHanded(null);");
        expect(body).toContain("setGeneration((current) => current + 1);");
    });

    it("empties it the same way everywhere, not only on send", async () => {
        // Sending, scheduling, saving an edit and cancelling one all empty the
        // box, and every one of them left the emoji behind. Putting a draft
        // aside and bringing one back empty it too.
        const source = await composer;
        expect(source.split("emptyTheBox();").length - 1).toBe(6);
    });
});
