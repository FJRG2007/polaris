// @vitest-environment jsdom

/**
 * Adding a reaction beside the ones a message already has.
 *
 * Every chat puts a face after the reactions, so a message somebody already
 * reacted to takes another where the eye already is rather than in the toolbar
 * at its top. A message with no reactions gets none: a column of empty faces
 * under every line is noise.
 */

import { MessagesWrapper } from "../setup/i18n";
import { MessageList } from "@/app/(app)/chat/message-list";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const opened: string[][] = [];

vi.mock("@/app/(app)/chat/actions", () => ({
    saveMediaAction: async () => ({}),
    unsaveMediaAction: async () => ({}),
    linkPreviewAction: async () => ({}),
    openDirectAction: async ({ userIds }: { userIds: string[] }) => {
        opened.push(userIds);
        return { id: "d1" };
    }
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

const pushed: string[] = [];
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: (to: string) => pushed.push(to), refresh: () => undefined })
}));

function message(id: string, authorId: string) {
    return {
        id,
        channelId: "c1",
        authorId,
        authorName: authorId,
        kind: "text" as const,
        body: `message ${id}`,
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
        createdAt: new Date(1_700_000_000_000).toISOString()
    };
}

function list(reactions: Array<{ emoji: string; count: number; mine: boolean }>) {
    return render(
        <MessageList
            messages={[{ ...message("m1", "grace"), reactions }]}
            viewerId="ada"
            canPost
            canModerate={false}
            onReact={() => undefined}
            onStar={() => undefined}
            onDelete={() => undefined}
        />,
        { wrapper: MessagesWrapper }
    );
}

afterEach(cleanup);

describe("the face after the reactions", () => {
    it("is offered on a message that has reactions", () => {
        list([{ emoji: "\u{1F923}", count: 1, mine: true }]);
        // One in the hover toolbar, one after the reactions.
        expect(screen.getAllByRole("button", { name: "Add reaction" })).toHaveLength(2);
    });

    it("is not drawn under a message nobody reacted to", () => {
        list([]);
        expect(screen.getAllByRole("button", { name: "Add reaction" })).toHaveLength(1);
    });
});
