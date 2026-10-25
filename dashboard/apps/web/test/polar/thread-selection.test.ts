/**
 * Choosing chats in Polar's list the way a file explorer does: Ctrl toggles,
 * Shift takes the stretch from the anchor, Ctrl+Shift adds it, and the keys
 * walk and stretch the list as it is drawn.
 */

import { describe, expect, it } from "vitest";
import { POLAR_BULK_MAX } from "@/lib/polar/shared";
import {
    actedOn,
    keepVisible,
    NO_SELECTION,
    pressThread,
    selectAllThreads,
    threadListKey
} from "@/components/polar/thread-selection";

const ORDER = ["a", "b", "c", "d", "e"];

describe("pressThread", () => {
    it("opens on a plain press", () => {
        expect(pressThread(ORDER, NO_SELECTION, "b", {})).toBe("open");
    });

    it("toggles with Ctrl or Cmd, and the box toggles without a key", () => {
        const one = pressThread(ORDER, NO_SELECTION, "b", { ctrlKey: true });
        expect(one).toEqual({ chosen: ["b"], anchor: "b" });
        const two = pressThread(ORDER, one as never, "d", { metaKey: true });
        expect(two).toEqual({ chosen: ["b", "d"], anchor: "d" });
        expect(pressThread(ORDER, two as never, "b", {}, true)).toEqual({
            chosen: ["d"],
            anchor: "b"
        });
    });

    it("replaces the selection with the stretch from the anchor on Shift", () => {
        const start = { chosen: ["a", "b"], anchor: "b" };
        expect(pressThread(ORDER, start, "d", { shiftKey: true })).toEqual({
            chosen: ["b", "c", "d"],
            anchor: "b"
        });
        expect(pressThread(ORDER, start, "a", { shiftKey: true })).toEqual({
            chosen: ["a", "b"],
            anchor: "b"
        });
    });

    it("adds the stretch with Ctrl+Shift", () => {
        const start = { chosen: ["e"], anchor: "a" };
        expect(pressThread(ORDER, start, "c", { shiftKey: true, ctrlKey: true })).toEqual({
            chosen: ["e", "a", "b", "c"],
            anchor: "a"
        });
    });

    it("chooses only the pressed chat on Shift when the anchor is gone", () => {
        expect(pressThread(ORDER, { chosen: [], anchor: "z" }, "c", { shiftKey: true })).toEqual({
            chosen: ["c"],
            anchor: "c"
        });
    });
});

describe("threadListKey", () => {
    it("takes everything on Ctrl+A and lets go on Escape", () => {
        expect(threadListKey(ORDER, NO_SELECTION, null, "a", { ctrlKey: true })).toEqual({
            kind: "select",
            selection: { chosen: ORDER, anchor: "a" }
        });
        expect(threadListKey(ORDER, { chosen: ["b"], anchor: "b" }, "b", "Escape", {})).toEqual({
            kind: "select",
            selection: NO_SELECTION
        });
        expect(threadListKey(ORDER, NO_SELECTION, "b", "Escape", {})).toBeNull();
    });

    it("moves the focus with the arrows, Home and End, and stops at the ends", () => {
        expect(threadListKey(ORDER, NO_SELECTION, "b", "ArrowDown", {})).toEqual({
            kind: "focus",
            focus: "c"
        });
        expect(threadListKey(ORDER, NO_SELECTION, "a", "ArrowUp", {})).toEqual({
            kind: "focus",
            focus: "a"
        });
        expect(threadListKey(ORDER, NO_SELECTION, "c", "End", {})).toEqual({
            kind: "focus",
            focus: "e"
        });
        expect(threadListKey(ORDER, NO_SELECTION, null, "ArrowDown", {})).toEqual({
            kind: "focus",
            focus: "a"
        });
    });

    it("stretches from the anchor with Shift+arrows", () => {
        const first = threadListKey(ORDER, NO_SELECTION, "b", "ArrowDown", { shiftKey: true });
        expect(first).toEqual({
            kind: "select",
            selection: { chosen: ["b", "c"], anchor: "b" },
            focus: "c"
        });
        const second = threadListKey(ORDER, { chosen: ["b", "c"], anchor: "b" }, "c", "ArrowDown", {
            shiftKey: true
        });
        expect(second).toEqual({
            kind: "select",
            selection: { chosen: ["b", "c", "d"], anchor: "b" },
            focus: "d"
        });
        const back = threadListKey(
            ORDER,
            { chosen: ["b", "c", "d"], anchor: "b" },
            "b",
            "ArrowUp",
            {
                shiftKey: true
            }
        );
        expect(back).toEqual({
            kind: "select",
            selection: { chosen: ["a", "b"], anchor: "b" },
            focus: "a"
        });
    });

    it("toggles the focused chat with Ctrl+Space", () => {
        expect(threadListKey(ORDER, NO_SELECTION, "c", " ", { ctrlKey: true })).toEqual({
            kind: "select",
            selection: { chosen: ["c"], anchor: "c" }
        });
    });

    it("asks to delete on Delete only when there is something to delete", () => {
        expect(threadListKey(ORDER, { chosen: ["a"], anchor: "a" }, null, "Delete", {})).toEqual({
            kind: "delete"
        });
        expect(threadListKey(ORDER, NO_SELECTION, "b", "Delete", {})).toEqual({ kind: "delete" });
        expect(threadListKey(ORDER, NO_SELECTION, null, "Delete", {})).toBeNull();
    });

    it("leaves every other key alone", () => {
        expect(threadListKey(ORDER, NO_SELECTION, "b", "Enter", {})).toBeNull();
        expect(threadListKey(ORDER, NO_SELECTION, "b", "x", {})).toBeNull();
        expect(threadListKey([], NO_SELECTION, null, "ArrowDown", {})).toBeNull();
    });
});

describe("the rest", () => {
    it("acts on the selection only when the row is part of it", () => {
        expect(actedOn({ chosen: ["a", "c"], anchor: "c" }, "c")).toEqual(["a", "c"]);
        expect(actedOn({ chosen: ["a", "c"], anchor: "c" }, "b")).toEqual(["b"]);
    });

    it("drops chats no longer on screen, and keeps the same object when nothing went", () => {
        const current = { chosen: ["a", "x"], anchor: "x" };
        expect(keepVisible(ORDER, current)).toEqual({ chosen: ["a"], anchor: null });
        const kept = { chosen: ["a"], anchor: "a" };
        expect(keepVisible(ORDER, kept)).toBe(kept);
    });

    it("keeps what was chosen first when everything is taken", () => {
        expect(selectAllThreads(ORDER, { chosen: ["d"], anchor: "d" }).chosen).toEqual([
            "d",
            "a",
            "b",
            "c",
            "e"
        ]);
    });
});

describe("a selection one action can take", () => {
    const LONG = Array.from({ length: POLAR_BULK_MAX + 50 }, (_, at) => `t${at}`);

    it("Ctrl+A keeps what was chosen and stops at the limit", () => {
        const all = selectAllThreads(LONG, { chosen: ["t240"], anchor: "t240" });
        expect(all.chosen).toHaveLength(POLAR_BULK_MAX);
        expect(all.chosen[0]).toBe("t240");
    });

    it("a stretch keeps the end at its anchor, either way", () => {
        const down = pressThread(LONG, { chosen: [], anchor: "t0" }, "t249", { shiftKey: true });
        expect(down).not.toBe("open");
        const downChosen = (down as { chosen: string[] }).chosen;
        expect(downChosen).toHaveLength(POLAR_BULK_MAX);
        expect(downChosen[0]).toBe("t0");
        const up = threadListKey(LONG, { chosen: [], anchor: "t249" }, "t249", "Home", {
            shiftKey: true
        });
        const upChosen = up?.kind === "select" ? up.selection.chosen : [];
        expect(upChosen).toHaveLength(POLAR_BULK_MAX);
        expect(upChosen.at(-1)).toBe("t249");
    });

    it("Ctrl adds nothing past the limit", () => {
        const full = { chosen: LONG.slice(0, POLAR_BULK_MAX), anchor: "t0" };
        const more = pressThread(LONG, full, "t249", { ctrlKey: true });
        expect((more as { chosen: string[] }).chosen).toEqual(full.chosen);
    });
});
