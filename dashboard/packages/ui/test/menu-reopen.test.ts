// @vitest-environment jsdom

/**
 * Right-clicking somewhere else while a context menu is open.
 *
 * The branch worth pinning is the one that says what counts as "inside the
 * menu". A submenu is a portal of its own, so it is not underneath the content
 * that opened it: measured against that content, right-clicking an option of an
 * open submenu reads as the page behind it, and the answer to the page behind it
 * is to suppress the native menu and aim the gesture again - at the same option,
 * which arrives back here, forever, while the menu never closes.
 *
 * So: inside any menu surface is left alone, outside one is re-aimed, and a
 * gesture this dispatched itself is never acted on a second time.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { reaimContextMenu } from "../src/lib/menu-reopen";

/** The one gesture, on whichever element the test hands it. */
function rightClick(on: Element): MouseEvent {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    on.dispatchEvent(event);
    return event;
}

beforeEach(() => {
    document.body.innerHTML = "";
    // Nothing under the pointer unless a test puts something there, so a re-aim
    // one of them leaves in flight cannot land in the middle of the next.
    document.elementFromPoint = () => null;
});

describe("a right-click while a menu is open", () => {
    it("leaves an option of the menu itself alone", () => {
        document.body.innerHTML = `
            <div data-radix-menu-content><button id="option">Rename</button></div>
        `;
        const option = document.querySelector("#option")!;
        const event = rightClick(option);
        reaimContextMenu(event);
        expect(event.defaultPrevented).toBe(false);
    });

    it("leaves an option of an open submenu alone, though it is a portal of its own", () => {
        // Rendered as Radix renders it: the submenu is a sibling of the menu
        // that opened it, not a descendant. Answering it would suppress the
        // native menu and re-dispatch the same gesture at the same option two
        // frames later, with nothing to end it.
        document.body.innerHTML = `
            <div data-radix-menu-content><button>Priority</button></div>
            <div data-radix-popper-content-wrapper>
                <div data-radix-menu-content><button id="urgent">Urgent</button></div>
            </div>
        `;
        const event = rightClick(document.querySelector("#urgent")!);
        reaimContextMenu(event);
        expect(event.defaultPrevented).toBe(false);
    });

    it("suppresses the native menu on the page behind it", async () => {
        // The press underneath has already started closing the menu, and two
        // menus arriving from one gesture is worse than none.
        document.body.innerHTML = `
            <div data-radix-menu-content><button>Rename</button></div>
            <li id="row">A message</li>
        `;
        const event = rightClick(document.querySelector("#row")!);
        reaimContextMenu(event);
        expect(event.defaultPrevented).toBe(true);
        await frames(4);
    });

    it("never acts on the gesture it aimed itself", async () => {
        // The re-aimed event is dispatched on the document's own tree, so it
        // arrives back here. Acting on it is the same unbounded loop by another
        // route - and this is what holds whatever the aim lands on.
        document.body.innerHTML = '<li id="row">A message</li>';
        const row = document.querySelector("#row")!;
        document.elementFromPoint = () => row;

        let seen = 0;
        document.addEventListener(
            "contextmenu",
            (event) => {
                seen += 1;
                reaimContextMenu(event as MouseEvent);
            },
            true
        );

        rightClick(row);
        await frames(6);
        // The gesture, and the one aimed at the row underneath it. Not a third.
        expect(seen).toBe(2);
    });
});

/** jsdom runs `requestAnimationFrame` on a timer, so the two the re-aim waits
 *  for have to be waited out rather than flushed. */
function frames(count: number): Promise<void> {
    return new Promise((resolve) => {
        let left = count;
        const step = () => (left-- > 0 ? requestAnimationFrame(step) : resolve());
        step();
    });
}
