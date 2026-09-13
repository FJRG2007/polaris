import { describe, expect, it } from "vitest";
import { attending } from "../../src/components/use-attention";

/**
 * Whether somebody is actually looking at the tab.
 *
 * One boolean expression, and it earns a test because both ways of getting it
 * wrong are invisible. Written too loosely, a conversation marks messages read
 * while the browser sits behind somebody's editor and the notification that would
 * have told them is swallowed as "already seen" - and nothing afterwards says
 * either of those happened. Written too tightly, a conversation somebody is
 * plainly reading stays bold, which is a thing they can see and complain about.
 */

describe("attending", () => {
    it("is true only for a visible, focused tab", () => {
        expect(attending("visible", true)).toBe(true);
    });

    it("is false for a tab in the background", () => {
        // Another tab selected, or the window minimised.
        expect(attending("hidden", true)).toBe(false);
        expect(attending("hidden", false)).toBe(false);
    });

    it("is false for a visible window with something on top of it", () => {
        // The case `visibilityState` alone misses: a call, an editor or a game
        // over the browser leaves the page visible and takes the focus.
        expect(attending("visible", false)).toBe(false);
    });

    it("treats a state it does not know as not being read", () => {
        // `prerender` exists, and a browser may add another. Anything that is not
        // plainly "visible" is not somebody reading.
        expect(attending("prerender", true)).toBe(false);
        expect(attending("", true)).toBe(false);
    });
});
