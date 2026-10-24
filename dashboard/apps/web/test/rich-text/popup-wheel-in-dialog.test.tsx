// @vitest-environment jsdom

/**
 * A suggestion list scrolls with the wheel over a modal dialog.
 *
 * The lists are mounted on the body, outside the dialog a task comment is
 * written in, and the dialog's scroll lock cancels every wheel that reaches the
 * document from outside it - so the "/" menu could not be scrolled with the
 * mouse. `mountPopup` keeps the list's own wheel events away from that lock.
 */

import { RemoveScroll } from "react-remove-scroll";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { mountPopup } from "@/components/rich-text/suggestion";

afterEach(cleanup);

/** What the suggestion plugin's own mount does with the element. */
function bodyMount(element: HTMLElement): () => void {
    document.body.appendChild(element);
    return () => element.remove();
}

function wheelOver(target: HTMLElement): WheelEvent {
    const event = new WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
}

describe("suggestion popup over a dialog", () => {
    it("is not cancelled by the dialog's scroll lock", () => {
        render(
            <RemoveScroll>
                <div>dialog</div>
            </RemoveScroll>
        );
        const popup = document.createElement("div");
        const row = document.createElement("button");
        popup.appendChild(row);
        const unmount = mountPopup(bodyMount, popup);
        expect(wheelOver(row).defaultPrevented).toBe(false);
        unmount();
        expect(popup.isConnected).toBe(false);
    });

    it("leaves the lock in force for everything else outside the dialog", () => {
        render(
            <RemoveScroll>
                <div>dialog</div>
            </RemoveScroll>
        );
        const outside = document.createElement("div");
        document.body.appendChild(outside);
        expect(wheelOver(outside).defaultPrevented).toBe(true);
        outside.remove();
    });
});
