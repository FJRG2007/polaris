// @vitest-environment jsdom

/**
 * How many lines of the conversation are drawn again when something happens.
 *
 * The screen that owns the list redraws itself on every typing frame, once a
 * second while anybody is typing, and on every presence change - and on a cheap
 * phone redrawing two hundred messages each time is what froze the app. The list
 * is handed fresh callbacks on each of those redraws, exactly as the screen hands
 * them, and no line may be drawn again for it. A new message draws itself and, at
 * most, the line above it, whose tick moves down to the new one.
 *
 * Counted through `useSwipeReply`, which every message row calls exactly once per
 * render and nothing else does.
 */

import { cleanup, render } from "@testing-library/react";
import { MessageList } from "@/app/(app)/chat/message-list";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rowRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/app/(app)/chat/swipe-reply", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/(app)/chat/swipe-reply")>();
    return {
        ...actual,
        useSwipeReply: (onReply: (() => void) | undefined) => {
            rowRenders.count += 1;
            return actual.useSwipeReply(onReply);
        }
    };
});

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
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));

function message(index: number) {
    return {
        id: `m${index}`,
        channelId: "c1",
        // Alternating, so the blocks are short and a new line's neighbour is
        // the one case where a row above legitimately changes.
        authorId: index % 2 === 0 ? "grace" : "ada",
        authorName: index % 2 === 0 ? "grace" : "ada",
        kind: "text" as const,
        body: `message ${index}`,
        parentId: null,
        replyCount: 0,
        lastReplyAt: null,
        edited: false,
        deleted: false,
        reactions: [],
        attachments: [],
        quote: null,
        starred: false,
        references: [],
        forwardable: true,
        link: null,
        preview: null,
        previewPending: false,
        receipt: null,
        createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString()
    };
}

const ROWS = 60;

/** The list as the channel screen draws it: every callback made anew. */
function list(messages: readonly ReturnType<typeof message>[]) {
    return (
        <MessageList
            messages={messages}
            viewerId="ada"
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

beforeEach(() => {
    rowRenders.count = 0;
});
afterEach(cleanup);

describe("message list redraws", () => {
    const messages = Array.from({ length: ROWS }, (_, index) => message(index));

    it("draws every line at most twice on the first render", () => {
        // Once, and once more for the swipe hook picking up its row element.
        render(list(messages));
        expect(rowRenders.count).toBeLessThanOrEqual(ROWS * 2);
    });

    it("draws no line again when the screen redraws for a typing frame", () => {
        const view = render(list(messages));
        rowRenders.count = 0;
        // Ten redraws: the typing tick, a presence change, a frame from
        // somebody else's conversation.
        for (let tick = 0; tick < 10; tick += 1) view.rerender(list(messages));
        expect(rowRenders.count).toBe(0);
    });

    it("draws only the new line and its neighbour when a message arrives", () => {
        const view = render(list(messages));
        rowRenders.count = 0;
        view.rerender(list([...messages, message(ROWS)]));
        expect(rowRenders.count).toBeLessThanOrEqual(2);
    });

    it("draws only the changed line when one message is reacted to", () => {
        const view = render(list(messages));
        rowRenders.count = 0;
        const changed = messages.map((entry, index) =>
            index === 10 ? { ...entry, starred: true } : entry
        );
        view.rerender(list(changed));
        expect(rowRenders.count).toBe(1);
    });
});
