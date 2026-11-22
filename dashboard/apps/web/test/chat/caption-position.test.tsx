// @vitest-environment jsdom

/**
 * Where a message's text is drawn beside the pictures it came with, for the
 * reader's own Chat setting: above them by default (Discord), under them for a
 * reader who chose "below" (WhatsApp). The stored message is the same either
 * way; only this reader's drawing changes, and it follows a change at once.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { MessageList } from "@/app/(app)/chat/message-list";
import { rememberChatPreferences } from "@/app/(app)/chat/chat-preferences";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/chat/preference-actions", () => ({
    chatPreferencesAction: () => new Promise(() => undefined),
    setCaptionPositionAction: async () => ({ error: "unused" })
}));

vi.mock("@/app/(app)/chat/actions", () => ({
    saveMediaAction: async () => ({}),
    unsaveMediaAction: async () => ({}),
    linkPreviewAction: async () => ({}),
    openDirectAction: async () => ({ id: "d1" })
}));

vi.mock("@/app/(app)/account/privacy/actions", () => ({
    listBlockedAction: async () => ({ people: [] }),
    blockPersonAction: async () => ({}),
    unblockPersonAction: async () => ({})
}));
vi.mock("@/app/(app)/account/report-actions", () => ({
    reportPersonAction: async () => ({})
}));

vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({
        blocked: new Set<string>(),
        friends: new Set<string>(),
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
    useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => {} })
}));

const message = {
    id: "m1",
    channelId: "c1",
    authorId: "grace",
    authorName: "grace",
    kind: "text" as const,
    body: "look at this",
    parentId: null,
    replyCount: 0,
    lastReplyAt: null,
    edited: false,
    deleted: false,
    reactions: [],
    attachments: [
        {
            id: "f1",
            name: "beach.png",
            size: 1000,
            contentType: "image/png",
            inline: true,
            durationMs: null,
            waveform: null,
            hasPoster: false,
            width: 400,
            height: 300,
            thumbhash: null,
            spoiler: false,
            borrowed: false
        }
    ],
    quote: null,
    starred: false,
    references: [],
    forwardable: true,
    link: null,
    preview: null,
    previewPending: false,
    receipt: null,
    createdAt: new Date(1_700_000_000_000).toISOString()
};

function list(viewerId: string) {
    return (
        <MessageList
            messages={[message]}
            viewerId={viewerId}
            canPost
            canModerate={false}
            pinnedIds={new Set<string>()}
            onReact={async () => undefined}
            onStar={async () => undefined}
            onReply={() => undefined}
            onReplyPrivately={() => undefined}
            onForward={() => undefined}
            onEdit={() => undefined}
            onDelete={() => undefined}
            onMarkUnread={async () => undefined}
            onMention={() => undefined}
            onOpenThread={() => undefined}
            threadAllowed={() => true}
            onJumpTo={() => undefined}
        />
    );
}

/** Whether the text comes before the picture in the page. */
function textFirst(container: HTMLElement): boolean {
    const text = screen.getByText("look at this");
    const picture = container.querySelector('[data-attachment="f1"]');
    expect(picture).not.toBeNull();
    return Boolean(text.compareDocumentPosition(picture!) & Node.DOCUMENT_POSITION_FOLLOWING);
}

afterEach(cleanup);

describe("caption position", () => {
    it("draws the text above the pictures by default", () => {
        const { container } = render(list("ada"));
        expect(textFirst(container)).toBe(true);
    });

    it("draws the text under the pictures for a reader who chose below", () => {
        rememberChatPreferences("bob", { captionPosition: "below" });
        const { container } = render(list("bob"));
        expect(textFirst(container)).toBe(false);
        expect(screen.getAllByText("look at this")).toHaveLength(1);
    });

    it("follows a change made while the list is open", () => {
        rememberChatPreferences("cy", { captionPosition: "above" });
        const { container } = render(list("cy"));
        expect(textFirst(container)).toBe(true);
        act(() => rememberChatPreferences("cy", { captionPosition: "below" }));
        expect(textFirst(container)).toBe(false);
    });
});
