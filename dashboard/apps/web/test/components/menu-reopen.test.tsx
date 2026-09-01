// @vitest-environment jsdom

/**
 * The watch that re-aims a right-click, and the two ways it was dangerous.
 *
 * Re-opening a context menu where the pointer now is means suppressing the
 * browser's own menu and dispatching a fresh gesture. Both halves of that are
 * things you must not do at the wrong moment, and the first version did both:
 *
 * - **It ran all the time.** `ContextMenuContent` is in the tree whether or not
 *   its menu is open - Radix gates on the open state inside the portal, below
 *   where the hook was called - and a ref never changes, so the effect ran once
 *   on mount and never again. The document listener was installed permanently,
 *   once per context menu in the application, and every right-click anywhere had
 *   its native menu killed: no paste in the composer, no "open link in a new
 *   tab", no spellcheck suggestions.
 * - **A submenu counted as outside.** Radix renders one into a portal of its own,
 *   so a right-click on a submenu item was not "inside the content", and the
 *   watch suppressed it and aimed a fresh right-click at the same item - which
 *   lands on a menu that is still open and does it again.
 *
 * Both are asserted on the hook rather than through a rendered menu, because
 * what is being pinned is exactly when the document listener exists.
 */

import { useReopenElsewhere } from "@polaris/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

/** A component that watches whatever node it is handed. */
function Watcher({ surface }: { surface: HTMLElement | null }) {
    useReopenElsewhere(surface);
    return null;
}

/** Right-click something, and say whether the browser's own menu survived. */
function rightClick(target: EventTarget): boolean {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    act(() => {
        target.dispatchEvent(event);
    });
    return !event.defaultPrevented;
}

/** A menu surface, marked the way Radix marks one. */
function menuSurface(): HTMLElement {
    const node = document.createElement("div");
    node.setAttribute("data-radix-menu-content", "");
    document.body.append(node);
    return node;
}

/**
 * `elementFromPoint` is what aims the second gesture, and jsdom has no layout so
 * it has none. The hook stands down entirely without it - which is deliberate,
 * and is why it has to be provided here: a test that let the guard fire would be
 * asserting that the watch does nothing.
 */
beforeEach(() => {
    Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        writable: true,
        value: () => null
    });
});

afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
});

describe("while no menu is open", () => {
    it("leaves the browser's own menu alone", () => {
        // The severe one. Every context menu in the application mounts this
        // component; if the watch is live with no menu open, right-clicking a
        // word in the composer loses its spellcheck suggestions.
        render(<Watcher surface={null} />);
        const page = document.createElement("p");
        document.body.append(page);
        expect(rightClick(page)).toBe(true);
    });
});

describe("while a menu is open", () => {
    it("takes over a right-click on the page behind it", () => {
        const surface = menuSurface();
        render(<Watcher surface={surface} />);
        const page = document.createElement("p");
        document.body.append(page);
        expect(rightClick(page)).toBe(false);
    });

    it("leaves a right-click on the menu itself alone", () => {
        const surface = menuSurface();
        render(<Watcher surface={surface} />);
        const item = document.createElement("div");
        surface.append(item);
        expect(rightClick(item)).toBe(true);
    });

    it("leaves a right-click on an open submenu alone", () => {
        // A submenu is a portal of its own, so it is not inside the surface the
        // watch was handed. Treating it as the page behind is what turned this
        // into a loop: the gesture it aimed landed back on the same item.
        const surface = menuSurface();
        render(<Watcher surface={surface} />);
        const submenu = menuSurface();
        const item = document.createElement("div");
        submenu.append(item);
        expect(rightClick(item)).toBe(true);
    });

    it("stops the moment the menu goes", () => {
        const surface = menuSurface();
        const view = render(<Watcher surface={surface} />);
        const page = document.createElement("p");
        document.body.append(page);
        expect(rightClick(page)).toBe(false);

        // What Radix does when the menu closes: the content unmounts and the
        // ref callback hands back null.
        view.rerender(<Watcher surface={null} />);
        expect(rightClick(page)).toBe(true);
    });
});
