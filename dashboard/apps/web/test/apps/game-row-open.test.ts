/**
 * Clicking anywhere on a server's row opens it, except on the row's own controls.
 */

import { describe, expect, it } from "vitest";
import { rowClickIntent } from "@polaris-app/game-servers/src/lib/row-open";

/** A target that is, or is not, inside one of the row's own controls. */
const target = (insideControl: boolean) => ({ closest: () => (insideControl ? {} : null) });
const click = (over: Partial<Parameters<typeof rowClickIntent>[0]> = {}) =>
    rowClickIntent({
        target: target(false),
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        selection: "",
        ...over
    });

describe("a click on a server's row", () => {
    it("opens it from anywhere that is not a control", () => {
        expect(click()).toBe("open");
    });

    it("leaves a button, a link or the copy button to do their own thing", () => {
        expect(click({ target: target(true) })).toBe("none");
    });

    it("opens a new tab on a middle click or with Ctrl or Cmd held", () => {
        expect(click({ button: 1 })).toBe("new-tab");
        expect(click({ ctrlKey: true })).toBe("new-tab");
        expect(click({ metaKey: true })).toBe("new-tab");
    });

    it("does nothing for a right click, a shift click, or finishing a text selection", () => {
        expect(click({ button: 2 })).toBe("none");
        expect(click({ shiftKey: true })).toBe("none");
        expect(click({ selection: "mc.example.com" })).toBe("none");
    });
});
