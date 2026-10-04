// @vitest-environment jsdom

/**
 * Opening a conversation straight from a link, before the rail's list is here.
 *
 * What is pinned: the messages are the first thing asked for - a browser runs
 * server actions one at a time, so whatever is asked first is what the rest
 * wait behind; a first page that lands before the list is a conversation still
 * arriving, not one the reader is refused; the first page brings the
 * conversation itself, so the header is drawn with it; once the list is here,
 * a conversation it does not have is refused as before; and a first page read
 * after the list - a new direct message the list has not caught up with - is
 * shown and the list asked again, until a newer list says otherwise.
 */

import { MessagesWrapper } from "../setup/i18n";
import { ChannelView } from "@/app/(app)/chat/channel-view";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The conversation, as the channel is drawn. */
const opened = [
    {
        id: "m1",
        channelId: "c1",
        authorId: "grace",
        authorName: "Grace",
        authorAvatar: null,
        body: "message m1",
        kind: "text",
        attachments: [],
        reactions: [],
        replyCount: 0,
        lastReplyAt: null,
        parentId: null,
        quoted: null,
        forwarded: false,
        editedAt: null,
        deletedAt: null,
        starred: false,
        references: [],
        mine: false,
        preview: null,
        previewPending: false,
        receipt: null,
        createdAt: new Date(1_700_000_000_000).toISOString()
    }
];

const dm = {
    id: "c1",
    name: "Grace",
    kind: "dm",
    spaceId: null,
    archived: false,
    unreadCount: 0,
    mayModerate: false,
    gameLinks: [],
    others: [{ id: "grace", name: "Grace" }]
};

/** What the chat context has, which is nothing until the list lands. */
let channels: (typeof dm)[] = [];
let loaded = false;
/** Which server actions were asked for, in order. */
let asked: string[] = [];
/** Whether the first page brings the conversation with it. */
let describes = false;
/** How many times the list was asked for again. */
let refreshed = 0;

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
    useSearchParams: () => new URLSearchParams()
}));

vi.mock("@/app/(app)/chat/actions", () => ({
    listScheduledAction: async () => ({ scheduled: [] }),
    readChannelAction: async () => {
        asked.push("messages");
        return {
            page: { messages: opened, olderThan: null, newerThan: null },
            ...(describes ? { channel: dm } : {})
        };
    },
    readSinceAction: async () => ({ page: { messages: [] } }),
    markReadAction: async () => ({}),
    receiptsAction: async () => ({ receipts: {} }),
    readThreadAction: async () => ({ messages: [] }),
    profileAction: async () => ({}),
    voicePresenceAction: async () => ({ inRoom: {} })
}));

vi.mock("@/app/(app)/chat/meeting-actions", () => ({
    liveCallAction: async () => {
        asked.push("call");
        return null;
    }
}));

vi.mock("@/app/(app)/chat/use-chat-stream", () => ({
    useChatStream: () => undefined
}));

vi.mock("@/app/(app)/account/privacy/actions", () => ({
    listBlockedAction: async () => ({ people: [] }),
    blockPersonAction: async () => ({}),
    unblockPersonAction: async () => ({})
}));
vi.mock("@/app/(app)/account/report-actions", () => ({ reportPersonAction: async () => ({}) }));

vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({
        blocked: new Set<string>(),
        friends: new Set<string>(),
        viewerId: "ada",
        viewerName: "Ada",
        may: { spaces: true, groups: true, attach: true, call: true, meetings: true },
        orgId: null,
        orgName: null,
        channels,
        spaces: [],
        categories: [],
        activeSpaceId: null,
        setActiveSpaceId: () => undefined,
        loaded,
        refresh: () => {
            refreshed += 1;
        },
        rulesFor: () => ({
            maxAttachments: 10,
            maxAttachmentMib: 25,
            maxAttachmentBytes: 25 * 1024 * 1024,
            deleteLeavesTrace: false,
            editWindowMinutes: 0
        })
    })
}));

vi.mock("@/app/(app)/chat/composer", () => ({ Composer: () => null }));
vi.mock("@/app/(app)/chat/call-room", () => ({ CallRoom: () => null }));
vi.mock("@/app/(app)/chat/thread-panel", () => ({ ThreadPanel: () => null }));
vi.mock("@/app/(app)/chat/search-panel", () => ({ SearchPanel: () => null }));
vi.mock("@/app/(app)/chat/forward-dialog", () => ({ ForwardDialog: () => null }));
vi.mock("@/app/(app)/chat/message-list", () => ({
    MessageList: ({ messages }: { messages: readonly { id: string }[] }) => (
        <ul>
            {messages.map((entry) => (
                <li key={entry.id}>{entry.id}</li>
            ))}
        </ul>
    )
}));
vi.mock("@/app/(app)/chat/channel-header", () => ({
    ChannelHeader: ({ channel }: { channel: { name: string } }) => <h1>{channel.name}</h1>
}));
vi.mock("@/app/(app)/chat/members-panel", () => ({
    ChannelMembers: () => null,
    useMembersPanel: () => ({ open: false, show: () => undefined, hide: () => undefined })
}));
vi.mock("@/app/(app)/chat/call-session", () => ({
    useCallHold: () => ({
        call: null,
        session: null,
        enter: () => undefined,
        leave: () => undefined,
        withVideo: false
    })
}));

beforeEach(() => {
    channels = [];
    loaded = false;
    asked = [];
    describes = false;
    refreshed = 0;
    Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
    cleanup();
});

const REFUSED = "This conversation is not yours to open.";

describe("a conversation opened before the list has arrived", () => {
    it("asks for its messages before anything else", async () => {
        render(<ChannelView channelId="c1" />, { wrapper: MessagesWrapper });
        await waitFor(() => expect(asked).toContain("call"));
        expect(asked[0]).toBe("messages");
    });

    it("waits rather than refusing while the list is still on its way", async () => {
        render(<ChannelView channelId="c1" />, { wrapper: MessagesWrapper });
        await waitFor(() => expect(asked).toContain("messages"));
        await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
        expect(screen.queryByText(REFUSED)).toBeNull();
    });

    it("draws the header from the first page when it brings the conversation", async () => {
        describes = true;
        render(<ChannelView channelId="c1" />, { wrapper: MessagesWrapper });
        expect(await screen.findByRole("heading", { name: "Grace" })).toBeTruthy();
        expect(await screen.findByText("m1")).toBeTruthy();
        expect(screen.queryByText(REFUSED)).toBeNull();
    });

    it("is refused once the list is here and does not have it", async () => {
        loaded = true;
        render(<ChannelView channelId="c1" />, { wrapper: MessagesWrapper });
        expect(await screen.findByText(REFUSED)).toBeTruthy();
    });

    it("shows a conversation the list has not caught up with, and asks for the list again", async () => {
        // A new direct message: the page was read after the list was.
        describes = true;
        loaded = true;
        render(<ChannelView channelId="c1" />, { wrapper: MessagesWrapper });
        expect(await screen.findByRole("heading", { name: "Grace" })).toBeTruthy();
        expect(refreshed).toBeGreaterThan(0);
        expect(screen.queryByText(REFUSED)).toBeNull();
    });

    it("lets a list that arrives after the first page overrule it", async () => {
        // Removed from it between the two answers: the newer list is the authority.
        describes = true;
        loaded = true;
        const view = render(<ChannelView channelId="c1" />, { wrapper: MessagesWrapper });
        expect(await screen.findByRole("heading", { name: "Grace" })).toBeTruthy();
        channels = [];
        view.rerender(<ChannelView channelId="c1" />);
        expect(await screen.findByText(REFUSED)).toBeTruthy();
    });
});
