// @vitest-environment jsdom

/**
 * A link in a previewed page or an agent's HTML artifact opens outside the
 * frame (BUG-0020 sweep): before, the preview's sandbox had no popups, so a
 * `target=_blank` link was blocked and a plain one navigated the frame into a
 * page that refuses to be framed.
 */

import { JSDOM } from "jsdom";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { withOutsideLinks } from "@/components/rich-text/code-run";

function drawn(body: string) {
    const dom = new JSDOM(withOutsideLinks(`<!doctype html><html><head></head><body>${body}</body></html>`), {
        runScripts: "dangerously",
        url: "https://polaris.example/notes"
    });
    const open = vi.fn();
    dom.window.open = open as never;
    const click = (id: string, button = 0) => {
        const event = new dom.window.MouseEvent(button === 0 ? "click" : "auxclick", { bubbles: true, cancelable: true, button });
        dom.window.document.getElementById(id)!.dispatchEvent(event);
        return event.defaultPrevented;
    };
    return { open, click };
}

describe("withOutsideLinks", () => {
    it("opens a web link outside the preview, left or middle click", () => {
        const { open, click } = drawn(`<a id="a" href="https://example.com/x">x</a><a id="b" target="_blank" href="mailto:a@example.com">m</a>`);
        expect(click("a")).toBe(true);
        expect(click("b", 1)).toBe(true);
        expect(open).toHaveBeenNthCalledWith(1, "https://example.com/x", "_blank", "noopener,noreferrer");
        expect(open).toHaveBeenNthCalledWith(2, "mailto:a@example.com", "_blank", "noopener,noreferrer");
    });

    it("leaves fragments, relative and other schemes to the page", () => {
        const { open, click } = drawn(`<a id="f" href="#top">f</a><a id="r" href="/notes/1">r</a><a id="j" href="javascript:void 0">j</a>`);
        expect(click("f")).toBe(false);
        expect(click("r")).toBe(false);
        expect(click("j")).toBe(false);
        expect(open).not.toHaveBeenCalled();
    });

    it("lets a page that handles its own click keep it", () => {
        const dom = new JSDOM(withOutsideLinks(`<a id="a" href="https://example.com/">a</a><script>document.getElementById("a").addEventListener("click", function (e) { e.preventDefault(); });</script>`), {
            runScripts: "dangerously"
        });
        const open = vi.fn();
        dom.window.open = open as never;
        dom.window.document.getElementById("a")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
        expect(open).not.toHaveBeenCalled();
    });
});

describe("frame sandboxes", () => {
    const source = (path: string) => readFileSync(join(__dirname, "../../src", path), "utf8");

    it("lets the preview and the artifact frame open links outside, never sharing this origin", () => {
        const preview = source("components/rich-text/code-run.tsx");
        expect(preview).toContain(`sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"`);
        const artifacts = source("components/agents/sessions/session-artifacts.tsx");
        expect(artifacts).toContain(`const ARTIFACT_FRAME_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";`);
        for (const text of [preview, artifacts]) expect(text).not.toMatch(/sandbox=.*allow-same-origin|SANDBOX = .*allow-same-origin/);
    });
});
