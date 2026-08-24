// @vitest-environment jsdom

/**
 * A link to a message, followed without reloading the conversation.
 *
 * The address of a message is the conversation's address with the message on the
 * end, so pressing one that was pasted into the room you are already reading is
 * a navigation to the room you are already reading: the screen unmounts, the
 * conversation is fetched again and every line of it is redrawn, to arrive where
 * scrolling gets in a frame. What the reader sees is the room blinking away and
 * coming back.
 *
 * So a quote of something said here scrolls instead, and writes the address
 * rather than travelling to it - a copied URL and a reload still land on the
 * line. A quote of something said somewhere else is a real journey and stays an
 * ordinary link, and so does one held with a modifier, which is somebody asking
 * the browser for a tab.
 */

import userEvent from "@testing-library/user-event";
import { MessageList } from "@/app/(app)/chat/message-list";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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
        refresh: () => undefined,
        spaces: [],
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
        ]
    })
}));

const pushed: string[] = [];
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: (to: string) => pushed.push(to), refresh: () => undefined })
}));

/** A message quoting one other message, said in `channelId`. */
function message(quotedIn: string) {
    return {
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
        attachments: [],
        quote: null,
        starred: false,
        references: [
            {
                kind: "message" as const,
                id: "q1",
                reachable: true,
                name: "A room",
                spaceId: "",
                spaceName: "",
                channelKind: "group",
                channelId: quotedIn,
                authorName: "ada",
                excerpt: "the thing said earlier",
                attachments: 0,
                at: new Date(1_699_000_000_000).toISOString()
            }
        ],
        forwardable: true,
        link: null,
        preview: null,
        previewPending: false,
        receipt: null,
        createdAt: new Date(1_700_000_000_000).toISOString()
    };
}

const jumped: string[] = [];

function list(quotedIn: string, jump: ((messageId: string) => void) | undefined) {
    return render(
        <MessageList
            messages={[message(quotedIn)]}
            viewerId="ada"
            canPost
            canModerate={false}
            onJumpTo={jump}
            onReact={() => undefined}
            onStar={() => undefined}
            onDelete={() => undefined}
        />
    );
}

const quote = () => screen.getByRole("link", { name: /the thing said earlier/ });

beforeEach(() => {
    jumped.length = 0;
    pushed.length = 0;
});

afterEach(cleanup);

describe("a quote of something said in this conversation", () => {
    it("is still addressed by the message, so a copied link is the line", () => {
        list("c1", (id) => jumped.push(id));
        expect(quote().getAttribute("href")).toBe("/chat/c/c1/q1");
    });

    it("scrolls to it rather than travelling to it", async () => {
        const user = userEvent.setup();
        list("c1", (id) => jumped.push(id));
        await user.click(quote());
        expect(jumped).toEqual(["q1"]);
    });

    it("leaves a modifier-click to the browser, which was asked for a tab", async () => {
        const user = userEvent.setup();
        list("c1", (id) => jumped.push(id));
        await user.keyboard("{Meta>}");
        await user.click(quote());
        await user.keyboard("{/Meta}");
        expect(jumped).toEqual([]);
    });
});

describe("a quote of something said elsewhere", () => {
    it("stays a link, because that one is a real journey", async () => {
        const user = userEvent.setup();
        list("c2", (id) => jumped.push(id));
        expect(quote().getAttribute("href")).toBe("/chat/c/c2/q1");
        await user.click(quote());
        expect(jumped).toEqual([]);
    });
});

describe("a list with nowhere to scroll", () => {
    it("keeps the link, so a thread panel still opens the message", async () => {
        const user = userEvent.setup();
        list("c1", undefined);
        await user.click(quote());
        expect(jumped).toEqual([]);
    });
});
