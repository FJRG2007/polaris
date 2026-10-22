// @vitest-environment jsdom

/**
 * The calendar's "+N more" popover on a day in the last row.
 *
 * FullCalendar keeps it clear of the top and the sides of the window but not
 * the bottom, so it opened past the bottom of the screen and the last entries
 * could not be reached. It is now moved up until it fits, and capped to the
 * room there is so its list scrolls.
 */

import { describe, expect, it } from "vitest";
import { fitPopover, keepPopoversInView } from "@polaris-app/calendar/src/screens/popover-fit";

/** A popover jsdom reports at `top` with `height`, following its own style.top
 *  the way a browser would. */
function popoverAt(top: number, height: number, offsetTop = 0): HTMLElement {
    const element = document.createElement("div");
    element.className = "fc-popover";
    element.style.top = `${top - offsetTop}px`;
    element.getBoundingClientRect = () => {
        const placed = (Number.parseFloat(element.style.top) || 0) + offsetTop;
        const capped = element.style.maxHeight ? Number.parseFloat(element.style.maxHeight) : height;
        const shown = Math.min(height, capped);
        return { top: placed, bottom: placed + shown, height: shown } as DOMRect;
    };
    return element;
}

describe("the more popover", () => {
    it("moves up until its bottom is on screen", () => {
        const popover = popoverAt(700, 300);
        fitPopover(popover, { top: 0, bottom: 800 });
        expect(popover.getBoundingClientRect().bottom).toBeLessThanOrEqual(790);
        expect(popover.getBoundingClientRect().top).toBe(490);
    });

    it("stays where it is when it already fits", () => {
        const popover = popoverAt(100, 200);
        fitPopover(popover, { top: 0, bottom: 800 });
        expect(popover.getBoundingClientRect().top).toBe(100);
    });

    it("never goes above the top, and scrolls inside when even that is too short", () => {
        const popover = popoverAt(300, 2000);
        fitPopover(popover, { top: 0, bottom: 800 });
        expect(popover.style.maxHeight).toBe("780px");
        const rect = popover.getBoundingClientRect();
        expect(rect.top).toBeGreaterThanOrEqual(10);
        expect(rect.bottom).toBeLessThanOrEqual(790);
    });

    it("keeps to the calendar's own area when that ends above the window's bottom", () => {
        const popover = popoverAt(500, 300, 100);
        fitPopover(popover, { top: 100, bottom: 700 });
        expect(popover.getBoundingClientRect().bottom).toBeLessThanOrEqual(690);
    });

    it("fits a popover the moment it appears inside the calendar", async () => {
        const root = document.createElement("div");
        root.getBoundingClientRect = () => ({ top: 0, bottom: 800 }) as DOMRect;
        document.body.append(root);
        Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
        const stop = keepPopoversInView(root);
        const popover = popoverAt(700, 300);
        root.append(popover);
        await Promise.resolve();
        expect(popover.getBoundingClientRect().bottom).toBeLessThanOrEqual(790);
        stop();
        root.remove();
    });
});
