// @vitest-environment jsdom

/**
 * A click on a link in a message is handed to the page rather than left to the
 * sandboxed frame, whose popup the phone app's WebView had nowhere to put.
 */

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { frameDocument } from "@/app/(app)/mail/message-body";

function drawn(body: string) {
    const dom = new JSDOM(frameDocument(body, false, "reader", "https://polaris.example"), {
        runScripts: "dangerously"
    });
    const posted: unknown[] = [];
    dom.window.parent.postMessage = ((data: unknown) => posted.push(data)) as never;
    return { document: dom.window.document, window: dom.window, posted };
}

function click(window: Window, target: Element, button = 0): boolean {
    const event = new window.MouseEvent(button === 0 ? "click" : "auxclick", {
        bubbles: true,
        cancelable: true,
        button
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
}

describe("links in a message frame", () => {
    it("hands a web link to the page and keeps the frame from opening it", () => {
        const { document, window, posted } = drawn(
            `<p><a href="https://example.com/a?b=1"><span id="in">open</span></a></p>`
        );
        expect(click(window as never, document.getElementById("in")!)).toBe(true);
        expect(posted).toContainEqual({ polarisMailOpen: "https://example.com/a?b=1" });
    });

    it("hands a mail link and a middle click over too", () => {
        const { document, window, posted } = drawn(
            `<a id="m" href="mailto:someone@example.com">mail</a><a id="w" href="https://example.com/">web</a>`
        );
        click(window as never, document.getElementById("m")!);
        click(window as never, document.getElementById("w")!, 1);
        expect(posted).toContainEqual({ polarisMailOpen: "mailto:someone@example.com" });
        expect(posted).toContainEqual({ polarisMailOpen: "https://example.com/" });
    });

    it("sends nothing for another scheme, and still stops the frame opening it", () => {
        const { document, window, posted } = drawn(`<a id="j" href="javascript:alert(1)">x</a>`);
        expect(click(window as never, document.getElementById("j")!)).toBe(true);
        expect(posted.filter((data) => (data as { polarisMailOpen?: unknown }).polarisMailOpen)).toEqual([]);
    });

    it("scrolls to a place in the message instead of opening it", () => {
        const { document, window, posted } = drawn(
            `<a id="top" href="#end">down</a><p id="end">end</p>`
        );
        let scrolled = false;
        (document.getElementById("end") as HTMLElement).scrollIntoView = () => {
            scrolled = true;
        };
        expect(click(window as never, document.getElementById("top")!)).toBe(true);
        expect(scrolled).toBe(true);
        expect(posted.some((data) => (data as { polarisMailOpen?: unknown }).polarisMailOpen)).toBe(false);
    });

    it("leaves a click that is not on a link alone", () => {
        const { document, window } = drawn(`<p id="p">text</p>`);
        expect(click(window as never, document.getElementById("p")!)).toBe(false);
    });
});
