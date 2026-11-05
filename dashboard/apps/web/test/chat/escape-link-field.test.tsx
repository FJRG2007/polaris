// @vitest-environment jsdom

/**
 * Escape while adding a link to a message backs out of the link and nothing
 * more: the conversation behind it stays open for the next press.
 */

import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useCloseOnEscape } from "@/app/(app)/chat/close-on-escape";
import { MessagesWrapper } from "../setup/i18n";

vi.mock("@tiptap/react/menus", () => ({
    BubbleMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));

const { SelectionToolbar } = await import("@/components/rich-text/toolbar");

// The conversation decides once the press has been handled everywhere, in the
// task after it - see `useCloseOnEscape`.
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

const editor = { isActive: () => false, getAttributes: () => ({}) } as unknown as Editor;

function Conversation({ onClose }: { onClose: () => void }) {
    useCloseOnEscape(onClose);
    return <SelectionToolbar editor={editor} />;
}

describe("the link field over a selection", () => {
    it("closes on Escape without closing the conversation", () => {
        const onClose = vi.fn();
        render(<Conversation onClose={onClose} />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("button", { name: "Add a link" }));

        fireEvent.keyDown(screen.getByRole("textbox", { name: "Link address" }), {
            key: "Escape"
        });
        expect(screen.queryByRole("textbox", { name: "Link address" })).toBeNull();
        vi.runOnlyPendingTimers();
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.keyDown(document.body, { key: "Escape" });
        vi.runOnlyPendingTimers();
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
