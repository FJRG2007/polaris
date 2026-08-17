// @vitest-environment jsdom

/**
 * A screenshot on the clipboard.
 *
 * Discord shows the picture, not a file name - pasting three screenshots in a
 * row used to be three identical-looking chips, which is how somebody sends the
 * wrong one. What lands in the staging tray from a paste has to be exactly what
 * a picked file gives: a thumbnail for something the browser can draw, and
 * nothing lost from the composer's own limits.
 */

import { DEFAULT_CHAT_RULES } from "@polaris/core";
import userEvent from "@testing-library/user-event";
import { Composer } from "@/app/(app)/chat/composer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/app/(app)/mention-actions", () => ({
    searchMentionsAction: async () => ({ results: [] }),
    resolveReferencesAction: async () => ({ labels: {} })
}));
vi.mock("@/app/(app)/chat/actions", () => ({
    typingAction: async () => undefined
}));

afterEach(cleanup);

// jsdom does no layout, so ProseMirror's coordinate-based caret placement has
// nothing real to call: neither the document nor a Range carries these in
// jsdom. Polyfilled to a stub rather than skipped, because clicking into the
// editor is otherwise how a person actually starts typing.
if (!document.elementFromPoint) document.elementFromPoint = () => null;
if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () =>
        ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }) as DOMRect;

function png(name: string): File {
    return new File(["fake-bytes"], name, { type: "image/png" });
}

/** ProseMirror's editable surface, which carries no accessible role of its own. */
async function editableSurface(container: HTMLElement): Promise<HTMLElement> {
    return waitFor(() => {
        const found = container.querySelector<HTMLElement>(".ProseMirror");
        if (!found) throw new Error("the editor did not mount");
        return found;
    });
}

/** A clipboard paste carrying files, dispatched on the editable surface. jsdom
 *  has neither `ClipboardEvent` nor `DataTransfer`, so this stands in with a
 *  plain event carrying a `DataTransfer`-shaped clipboardData: `files` for
 *  the composer's own handler, `getData` for the ProseMirror text path that
 *  runs ahead of it on every paste, screenshot or not. */
function pasteFiles(target: Element, files: File[]) {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
        value: { files, items: [], types: [], getData: () => "" }
    });
    target.dispatchEvent(event);
}

describe("pasting a screenshot into the composer", () => {
    it("stages it with a picture preview, not a filename chip", async () => {
        const { container } = render(
            <Composer
                channelId="c1"
                rules={DEFAULT_CHAT_RULES}
                disabled={false}
                placeholder="Message"
                onSend={() => undefined}
            />
        );

        const editable = await editableSurface(container);
        pasteFiles(editable, [png("screenshot.png")]);

        const preview = await screen.findByAltText("screenshot.png");
        expect(preview.tagName).toBe("IMG");
        // Not also drawn as the name-and-size chip a non-previewable file gets.
        expect(screen.queryByText("screenshot.png")).toBeNull();
    });

    it("keeps a chip, not a picture, for a file that draws no thumbnail", async () => {
        const { container } = render(
            <Composer
                channelId="c1"
                rules={DEFAULT_CHAT_RULES}
                disabled={false}
                placeholder="Message"
                onSend={() => undefined}
            />
        );

        const editable = await editableSurface(container);
        const sheet = new File(["a,b,c"], "numbers.csv", { type: "text/csv" });
        pasteFiles(editable, [sheet]);

        await screen.findByText("numbers.csv");
        expect(screen.queryByRole("img")).toBeNull();
    });

    it("refuses the paste when the room allows no files, and says so", async () => {
        const { container } = render(
            <Composer
                channelId="c1"
                rules={DEFAULT_CHAT_RULES}
                disabled={false}
                attachable={false}
                placeholder="Message"
                onSend={() => undefined}
            />
        );

        const editable = await editableSurface(container);
        pasteFiles(editable, [png("screenshot.png")]);

        await screen.findByText("You are not allowed to send files here.");
        expect(screen.queryByAltText("screenshot.png")).toBeNull();
    });
});

describe("focusing the composer for a reply", () => {
    it("brings the caret back rather than clearing what was already typed", async () => {
        const user = userEvent.setup();
        const message = {
            id: "m1",
            channelId: "c1",
            authorId: "grace",
            authorName: "Grace",
            kind: "text" as const,
            body: "were you free tomorrow?",
            parentId: null,
            replyCount: 0,
            lastReplyAt: null,
            edited: false,
            deleted: false,
            reactions: [],
            attachments: [],
            quote: null,
            starred: false,
            forwardable: true,
            link: null,
            preview: null,
            previewPending: false,
            receipt: null,
            createdAt: new Date(1_700_000_000_000).toISOString()
        };

        const { container, rerender } = render(
            <Composer
                channelId="c1"
                rules={DEFAULT_CHAT_RULES}
                disabled={false}
                placeholder="Message"
                onSend={() => undefined}
            />
        );

        const editable = await editableSurface(container);
        await user.click(editable);
        await user.type(editable, "sure, ");

        // Reply pressed mid-sentence: the box already carries what was typed, and
        // pressing Reply must not wipe it or move on from the end of it.
        rerender(
            <Composer
                channelId="c1"
                rules={DEFAULT_CHAT_RULES}
                disabled={false}
                placeholder="Message"
                replyingTo={message}
                onSend={() => undefined}
            />
        );

        await screen.findByText(/were you free tomorrow/);
        expect(editable.textContent).toBe("sure, ");
    });
});
