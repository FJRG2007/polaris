/**
 * Undo and redo of an automation being edited, and the clipboard blocks are
 * copied through: bounded, forgetting the redo branch on a new change, and only
 * ever handing a block back to the list it fits.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as history from "@polaris/ui/automation-history";
import * as clipboard from "@polaris/ui/automation-clipboard";

describe("draft history", () => {
    it("takes changes back and puts them again", () => {
        let state = history.historyOf("a");
        state = history.recorded(state, "b");
        state = history.recorded(state, "c");
        state = history.undone(state);
        expect(state.present).toBe("b");
        state = history.undone(state);
        expect(state.present).toBe("a");
        expect(history.undone(state)).toBe(state);
        state = history.redone(state);
        expect(state.present).toBe("b");
        expect(state.future).toEqual(["c"]);
    });

    it("forgets what could be redone once something new is changed", () => {
        let state = history.recorded(history.historyOf("a"), "b");
        state = history.recorded(history.undone(state), "x");
        expect(state.future).toEqual([]);
        expect(history.redone(state)).toBe(state);
    });

    it("keeps no more than its limit of steps", () => {
        let state = history.historyOf(0);
        for (let step = 1; step <= history.HISTORY_LIMIT + 10; step += 1)
            state = history.recorded(state, step);
        expect(state.past).toHaveLength(history.HISTORY_LIMIT);
        expect(state.past[0]).toBe(10);
    });

    it("records nothing for a change that changes nothing", () => {
        const state = history.historyOf("a");
        expect(history.recorded(state, "a")).toBe(state);
    });
});

describe("block clipboard", () => {
    afterEach(() => clipboard.clearClipboard());

    it("hands a block back only to the surface and list it came from", () => {
        clipboard.copyBlock({ surface: "places", role: "trigger", block: { id: "a", kind: "manual" } });
        expect(clipboard.hasBlock("places", "trigger")).toBe(true);
        expect(clipboard.hasBlock("places", "step")).toBe(false);
        expect(clipboard.pastedBlock("mail", "trigger")).toBeNull();
        expect(clipboard.pastedBlock("places", "trigger")).toEqual({ id: "a", kind: "manual" });
    });

    it("gives a fresh copy every time, untouched by what was edited after", () => {
        const block = { id: "a", items: [1] };
        clipboard.copyBlock({ surface: "places", role: "step", block });
        block.items.push(2);
        const first = clipboard.pastedBlock("places", "step");
        expect(first).toEqual({ id: "a", items: [1] });
        expect(clipboard.pastedBlock("places", "step")).not.toBe(first);
    });
});
