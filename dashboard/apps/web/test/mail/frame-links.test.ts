// @vitest-environment jsdom

/**
 * A click on a link in a message is handed to the page rather than left to the
 * sandboxed frame, whose popup the phone app's WebView had nowhere to put.
 */

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { frameDocument } from "@/app/(app)/mail/message-body";

function drawn(body: string, url?: string) {
    const dom = new JSDOM(frameDocument(body, false, "reader", "https://polaris.example"), {
        runScripts: "dangerously",
        ...(url ? { url } : {})
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

    // BUG-0020: every link the frame cancels, it either opens, scrolls or
    // refuses for its scheme - none is swallowed because it could not be read.
    const opened = (posted: unknown[]) =>
        posted.map((data) => (data as { polarisMailOpen?: unknown }).polarisMailOpen).filter(Boolean);

    it("opens an SVG link, whose href is not a string", () => {
        const { document, window, posted } = drawn(
            `<svg><a href="https://example.com/svg"><rect id="r" width="9" height="9"/></a></svg>`
        );
        expect(click(window as never, document.getElementById("r")!)).toBe(true);
        expect(opened(posted)).toEqual(["https://example.com/svg"]);
    });

    it("opens an SVG link written with xlink:href", () => {
        const { document, window, posted } = drawn(
            `<svg xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="https://example.com/x"><rect id="r"/></a></svg>`
        );
        click(window as never, document.getElementById("r")!);
        expect(opened(posted)).toEqual(["https://example.com/x"]);
    });

    it("opens an image-map area", () => {
        const { document, window, posted } = drawn(
            `<map name="m"><area id="a" shape="rect" coords="0,0,9,9" href="https://example.com/area"></map>`
        );
        expect(click(window as never, document.getElementById("a")!)).toBe(true);
        expect(opened(posted)).toEqual(["https://example.com/area"]);
    });

    it("resolves a relative link against the frame's base", () => {
        const { document, window, posted } = drawn(
            `<a id="l" href="/track?id=1">rel</a>`,
            "https://polaris.example/mail"
        );
        click(window as never, document.getElementById("l")!);
        expect(opened(posted)).toEqual(["https://polaris.example/track?id=1"]);
    });

    it("keeps a long address whole and trims the spaces around it", () => {
        const long = `https://example.com/c?u=${"a".repeat(5000)}`;
        const { document, window, posted } = drawn(`<a id="l" href="  ${long}
">long</a>`);
        click(window as never, document.getElementById("l")!);
        expect(opened(posted)).toEqual([long]);
    });

    it("leaves an anchor with no address alone", () => {
        const { document, window, posted } = drawn(`<a id="n" name="x">no href</a>`);
        expect(click(window as never, document.getElementById("n")!)).toBe(false);
        expect(opened(posted)).toEqual([]);
    });

    it("refuses a custom scheme without opening it", () => {
        const { document, window, posted } = drawn(`<a id="t" href="ms-settings:x">x</a>`);
        expect(click(window as never, document.getElementById("t")!)).toBe(true);
        expect(opened(posted)).toEqual([]);
    });

    it("offers the link menu for an SVG link too", () => {
        const { document, window, posted } = drawn(
            `<svg><a href="https://example.com/svg"><rect id="r"/></a></svg>`
        );
        document.getElementById("r")!.dispatchEvent(
            new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })
        );
        expect(posted).toContainEqual({ polarisMailMenu: expect.objectContaining({ href: "https://example.com/svg" }) });
    });

    it("draws the frame in a sandbox that never shares this origin", async () => {
        const source = (await import("node:fs")).readFileSync(
            "src/app/(app)/mail/message-body.tsx",
            "utf8"
        );
        const sandbox = source.match(/sandbox="([^"]+)"/)?.[1].split(" ") ?? [];
        expect(sandbox).toEqual(
            expect.arrayContaining(["allow-scripts", "allow-popups", "allow-popups-to-escape-sandbox"])
        );
        expect(sandbox).not.toContain("allow-same-origin");
    });
});
