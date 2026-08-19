// @vitest-environment jsdom

/**
 * The writer's name, in the middle of what they wrote.
 *
 * It used to be a label, which left the roster as the only place to reach
 * anything about a person - a column somebody has to open first, and in a busy
 * channel the person worth muting is the one on screen rather than the one being
 * scrolled to in a list of two hundred. So the name is pressable now, and the
 * right-click on it asks about the person rather than about the message.
 *
 * Your own name is left as a label. Everything the menu offers reads oddly aimed
 * at yourself, and there is no conversation to open with you.
 */

import userEvent from "@testing-library/user-event";
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

vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({
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
        forwardable: true,
        link: null,
        preview: null,
        previewPending: false,
        receipt: null,
        createdAt: new Date(1_700_000_000_000).toISOString()
    };
}

function list() {
    return render(
        <MessageList
            messages={[message("m1", "grace"), message("m2", "ada")]}
            viewerId="ada"
            canPost
            canModerate={false}
            onReact={() => undefined}
            onStar={() => undefined}
            onDelete={() => undefined}
        />
    );
}

afterEach(cleanup);

describe("somebody else's name", () => {
    it("is pressable", () => {
        list();
        expect(screen.getByRole("button", { name: "grace" })).toBeDefined();
    });

    it("opens the conversation with them, which is what pressing a name does in the roster", async () => {
        const user = userEvent.setup();
        list();
        opened.length = 0;
        pushed.length = 0;
        await user.click(screen.getByRole("button", { name: "grace" }));
        expect(opened).toEqual([["grace"]]);
        expect(pushed).toEqual(["/chat/c/d1"]);
    });
});

describe("your own name", () => {
    it("is not pressable, because none of it is aimed at yourself", () => {
        list();
        expect(screen.queryByRole("button", { name: "ada" })).toBeNull();
        expect(screen.getByText("ada")).toBeDefined();
    });
});
