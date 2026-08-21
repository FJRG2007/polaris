// @vitest-environment jsdom

/**
 * Whether a streaming log takes the scrollbar away from whoever is reading it.
 *
 * A build log is read while it is still being written, and the two things it has
 * to do pull against each other: show the newest line without being asked, and
 * hold still the moment somebody scrolls back to read what went past. Getting the
 * second one wrong is what makes an error impossible to read - every four seconds
 * the poll drags the view back down to the tail.
 *
 * jsdom lays nothing out, so the three numbers the decision is made from are set
 * on the element by hand.
 */

import { LogViewer } from "@/components/log-viewer";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

afterEach(cleanup);

const VIEWPORT = 200;
const HEIGHT = 1000;

/** The element the log scrolls in, given a size jsdom would otherwise call zero. */
function scroller(container: HTMLElement): HTMLElement {
    const element = container.querySelector(".overflow-auto");
    if (!(element instanceof HTMLElement)) throw new Error("the log viewer has no scrolling region");
    Object.defineProperty(element, "scrollHeight", { configurable: true, value: HEIGHT });
    Object.defineProperty(element, "clientHeight", { configurable: true, value: VIEWPORT });
    return element;
}

/** Where the scrollbar sits when the view is at the newest line. */
const BOTTOM = HEIGHT - VIEWPORT;

describe("a log that is still being written", () => {
    it("shows the newest output while the reader is at the tail", () => {
        const { container, rerender } = render(<LogViewer log="first line" />);
        const element = scroller(container);

        rerender(<LogViewer log={"first line\nsecond line"} />);

        expect(element.scrollTop).toBe(HEIGHT);
    });

    it("stays where it was put once the reader scrolls back into what went past", () => {
        const { container, rerender } = render(<LogViewer log="first line" />);
        const element = scroller(container);

        element.scrollTop = 120;
        fireEvent.scroll(element);
        rerender(<LogViewer log={"first line\nsecond line"} />);

        expect(element.scrollTop).toBe(120);
    });

    it("follows the tail again as soon as the reader returns to it", () => {
        const { container, rerender } = render(<LogViewer log="first line" />);
        const element = scroller(container);

        element.scrollTop = 120;
        fireEvent.scroll(element);
        rerender(<LogViewer log={"first line\nsecond line"} />);

        element.scrollTop = BOTTOM;
        fireEvent.scroll(element);
        rerender(<LogViewer log={"first line\nsecond line\nthird line"} />);

        expect(element.scrollTop).toBe(HEIGHT);
    });

    it("leaves the view alone entirely where following was not asked for", () => {
        const { container, rerender } = render(<LogViewer log="first line" autoScroll={false} />);
        const element = scroller(container);

        rerender(<LogViewer log={"first line\nsecond line"} autoScroll={false} />);

        expect(element.scrollTop).toBe(0);
    });
});
