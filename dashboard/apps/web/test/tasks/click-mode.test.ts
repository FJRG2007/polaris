/**
 * What a click on a task means.
 *
 * Five views answer this gesture, and they answer it by calling one function, so
 * the thing worth pinning down is that function rather than each view. The case
 * that matters is the plain click: it has to stay "open the task", because a
 * board where clicking a card selects it instead is a board nobody can use.
 */

import { describe, expect, it } from "vitest";
import { clickMode } from "../../src/app/(app)/tasks/views/shared";

const click = (keys: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}) =>
    clickMode({ metaKey: false, ctrlKey: false, shiftKey: false, ...keys });

describe("what a click on a task means", () => {
    it("opens the task when nothing is held", () => {
        expect(click()).toBeNull();
    });

    it("toggles it into the selection on ctrl, and on cmd for the same reason", () => {
        expect(click({ ctrlKey: true })).toBe("toggle");
        expect(click({ metaKey: true })).toBe("toggle");
    });

    it("takes the range on shift", () => {
        expect(click({ shiftKey: true })).toBe("range");
    });

    it("takes the range on ctrl-shift too", () => {
        // Both held is how people reach for "add this run to what I already have",
        // and the range adds rather than replaces, so it is the same answer.
        expect(click({ ctrlKey: true, shiftKey: true })).toBe("range");
        expect(click({ metaKey: true, shiftKey: true })).toBe("range");
    });
});
