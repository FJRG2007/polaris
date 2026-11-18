// @vitest-environment jsdom

/**
 * Enter on a phone breaks the line.
 *
 * A phone's keyboard has no shift to hold with Enter, so a composer that sends
 * on Enter there was one nobody could write two lines in. On a phone Enter now
 * puts a line break in and the send button sends, the way WhatsApp and Telegram
 * do; a computer keeps Enter to send and shift+Enter to break the line.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

vi.mock("@/app/(app)/mention-actions", () => ({
    resolveReferencesAction: async () => ({}),
    searchMentionsAction: async () => []
}));

const { RichTextEditor } = await import("@/components/rich-text/rich-text-editor");
const { enterBreaksLine } = await import("@/lib/enter-key");

if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();
if (!Element.prototype.getClientRects) Element.prototype.getClientRects = () => [] as unknown as DOMRectList;

/** A device answering the pointer queries the way a phone or a computer does. */
function device(kind: "phone" | "computer" | "tablet-with-trackpad") {
    vi.stubGlobal("matchMedia", (query: string) => ({
        matches:
            query === "(pointer: coarse)" ? kind !== "computer" : query === "(any-pointer: fine)" ? kind !== "phone" : false,
        media: query,
        addEventListener() {},
        removeEventListener() {}
    }));
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

async function composer(onSubmit: (markdown: string) => void) {
    const { container } = render(<RichTextEditor value="first line" onSubmit={onSubmit} />, {
        wrapper: MessagesWrapper
    });
    const field = await waitFor(() => {
        const found = container.querySelector<HTMLElement>(".ProseMirror");
        if (!found) throw new Error("no editor yet");
        return found;
    });
    return field;
}

describe("Enter in a composer", () => {
    it("is read from the pointer the device has", () => {
        device("phone");
        expect(enterBreaksLine()).toBe(true);
        device("computer");
        expect(enterBreaksLine()).toBe(false);
        device("tablet-with-trackpad");
        expect(enterBreaksLine()).toBe(false);
    });

    it("breaks the line on a phone instead of sending", async () => {
        device("phone");
        const onSubmit = vi.fn();
        const field = await composer(onSubmit);
        fireEvent.keyDown(field, { key: "Enter" });
        expect(onSubmit).not.toHaveBeenCalled();
        await waitFor(() => expect(field.querySelector("br")).not.toBeNull());
        expect(field.getAttribute("enterkeyhint")).toBe("enter");
    });

    it("sends on a computer", async () => {
        device("computer");
        const onSubmit = vi.fn();
        const field = await composer(onSubmit);
        fireEvent.keyDown(field, { key: "Enter" });
        await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("first line"));
        expect(field.getAttribute("enterkeyhint")).toBe("send");
    });
});
