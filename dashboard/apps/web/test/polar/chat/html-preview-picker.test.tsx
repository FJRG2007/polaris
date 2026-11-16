// @vitest-environment jsdom
/**
 * A chat answer's HTML preview: an opaque-origin frame, with the element
 * picker only inside a thread that takes picks. Fixture data throughout.
 */

import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CodeBlock } from "@/components/rich-text/code-block";
import { PreviewPickContext } from "@/components/preview/use-preview-picker";

const PICKED = {
    type: "polaris-picker",
    action: "picked",
    element: { tag: "h1", selector: "body > h1", html: "<h1>Hi</h1>", url: "about:srcdoc", box: { x: 0, y: 0, width: 10, height: 10 }, source: null }
};

afterEach(cleanup);

async function preview(onPick: ((element: unknown) => void) | null) {
    render(
        <PreviewPickContext.Provider value={onPick}>
            <CodeBlock code="<h1>Hi</h1>" language="html" />
        </PreviewPickContext.Provider>,
        { wrapper: MessagesWrapper }
    );
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));
    return (await screen.findByTitle("Preview of this page")) as HTMLIFrameElement;
}

describe("chat HTML preview", () => {
    it("is sandboxed without the page's own origin, and has no picker outside a thread that takes one", async () => {
        const frame = await preview(null);
        expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
        expect(frame.getAttribute("srcdoc")).not.toContain("data-polaris-picker");
        expect(screen.queryByRole("button", { name: /pick an element/i })).toBeNull();
    });

    it("carries the picker and hands on what the frame picked, from that frame only", async () => {
        const picked: unknown[] = [];
        const frame = await preview((element) => picked.push(element));
        expect(frame.getAttribute("srcdoc")).toContain("data-polaris-picker");
        const told: unknown[] = [];
        frame.contentWindow!.postMessage = ((message: unknown) => told.push(message)) as never;
        fireEvent.click(screen.getByRole("button", { name: /pick an element/i }));
        expect(told).toContainEqual({ type: "polaris-picker", action: "start" });
        window.dispatchEvent(new MessageEvent("message", { data: PICKED, origin: "null", source: window }));
        expect(picked).toEqual([]);
        await act(async () => {
            window.dispatchEvent(new MessageEvent("message", { data: PICKED, origin: "null", source: frame.contentWindow }));
        });
        expect(picked).toHaveLength(1);
    });
});
