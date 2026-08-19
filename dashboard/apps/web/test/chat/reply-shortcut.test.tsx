// @vitest-environment jsdom

/**
 * Answering a message without reaching for the mouse.
 *
 * The hover row already draws a pencil, a bin and an arrow, and F2 and Delete
 * already reach the first two from a keyboard. R was missing for the third, so
 * answering a message meant a pointer even for somebody who never left the
 * keyboard to get there - the one gesture in the row that had no shortcut.
 *
 * Proven through focus rather than hover: jsdom does not track `:hover`, and the
 * hook itself falls back to whatever has focus for exactly that reason - a
 * keyboard user reaches a message by tabbing to something in its row, not by
 * hovering it.
 */

import userEvent from "@testing-library/user-event";
import { MessageList } from "@/app/(app)/chat/message-list";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/app/(app)/chat/actions", () => ({
    saveMediaAction: async () => ({}),
    unsaveMediaAction: async () => ({}),
    linkPreviewAction: async () => ({}),
    openDirectAction: async () => ({ id: "d1" })
}));

// A name in a message is the person, and the person's menu asks the app which
// room this is and what this reader runs - see `Writer`.
vi.mock("@/app/(app)/account/privacy/actions", () => ({
    listBlockedAction: async () => ({ people: [] }),
    blockPersonAction: async () => ({}),
    unblockPersonAction: async () => ({})
}));

vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({
        blocked: new Set<string>(),
        refresh: () => undefined,
        channels: [
            {
                id: "c1",
                spaceId: null,
                categoryId: null,
                kind: "group",
                name: "A room",
                archived: false,
                ownerId: null,
                others: []
            }
        ],
        spaces: [],
        refresh: () => undefined
    })
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));

function message(id: string, authorId: string, body = `message ${id}`) {
    return {
        id,
        channelId: "c1",
        authorId,
        authorName: authorId,
        kind: "text" as const,
        body,
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
}

afterEach(cleanup);

describe("the R shortcut", () => {
    it("answers the message whose row has focus", async () => {
        const user = userEvent.setup();
        const onReply = vi.fn();
        render(
            <MessageList
                messages={[message("m1", "grace"), message("m2", "ada")]}
                viewerId="ada"
                canPost
                canModerate={false}
                onReact={() => undefined}
                onStar={() => undefined}
                onReply={onReply}
                onForward={() => undefined}
                onEdit={() => undefined}
                onDelete={() => undefined}
            />
        );

        // The star button is always drawn, so it is a reliable way to land focus
        // inside the first message's row without depending on hover.
        await user.tab();
        await user.keyboard("r");

        expect(onReply).toHaveBeenCalledTimes(1);
        expect(onReply.mock.calls[0]?.[0]?.id).toBe("m1");
    });

    it("does nothing when the composer refuses replies", async () => {
        const user = userEvent.setup();
        const onReply = vi.fn();
        render(
            <MessageList
                messages={[message("m1", "grace")]}
                viewerId="ada"
                canPost
                canModerate={false}
                onReact={() => undefined}
                onStar={() => undefined}
                onForward={() => undefined}
                onEdit={() => undefined}
                onDelete={() => undefined}
            />
        );

        await user.tab();
        await user.keyboard("r");
        expect(onReply).not.toHaveBeenCalled();
    });

    it("is the letter it types everywhere else, so a text field keeps it", async () => {
        const user = userEvent.setup();
        const onReply = vi.fn();
        render(
            <>
                <input aria-label="Somewhere else entirely" />
                <MessageList
                    messages={[message("m1", "grace")]}
                    viewerId="ada"
                    canPost
                    canModerate={false}
                    onReact={() => undefined}
                    onStar={() => undefined}
                    onReply={onReply}
                    onForward={() => undefined}
                    onEdit={() => undefined}
                    onDelete={() => undefined}
                />
            </>
        );

        const field = screen.getByLabelText("Somewhere else entirely");
        await user.click(field);
        await user.keyboard("r");

        expect(onReply).not.toHaveBeenCalled();
        expect((field as HTMLInputElement).value).toBe("r");
    });
});
