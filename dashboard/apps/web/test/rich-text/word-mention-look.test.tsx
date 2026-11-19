// @vitest-environment jsdom

/**
 * `@polar`, `@everyone` and `@here` look like mentions while they are written.
 *
 * They are stored as the words typed, so picking one from the list put plain
 * text back and the chip the list had shown was gone until the message was
 * sent. They are drawn as mentions in the editor too, and only where the
 * conversation reads them: never inside code.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

vi.mock("@/app/(app)/mention-actions", () => ({
    resolveReferencesAction: async () => ({}),
    searchMentionsAction: async () => []
}));
vi.mock("@/components/polar/polar-allowed", () => ({ usePolarAllowed: () => true }));

const { RichTextEditor } = await import("@/components/rich-text/rich-text-editor");

if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();
if (!Element.prototype.getClientRects) Element.prototype.getClientRects = () => [] as unknown as DOMRectList;

afterEach(cleanup);

async function drawn(value: string, mentionsIn: string | null) {
    const { container } = render(<RichTextEditor value={value} mentionsIn={mentionsIn} onSubmit={() => {}} />, {
        wrapper: MessagesWrapper
    });
    const field = await waitFor(() => {
        const found = container.querySelector<HTMLElement>(".ProseMirror");
        if (!found) throw new Error("no editor yet");
        return found;
    });
    return [...field.querySelectorAll<HTMLElement>("span.text-primary")].map((span) => span.textContent);
}

describe("a word mention in the editor", () => {
    it("is drawn as a mention in a conversation", async () => {
        expect(await drawn("@polar what is this, and @here too", "channel-1")).toEqual(["@polar", "@here"]);
    });

    it("is plain text inside code", async () => {
        expect(await drawn("`@polar` is how you ask", "channel-1")).toEqual([]);
    });

    it("is plain text where there is no conversation", async () => {
        expect(await drawn("@polar here", null)).toEqual([]);
    });
});
