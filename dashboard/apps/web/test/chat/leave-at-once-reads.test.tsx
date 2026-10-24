// @vitest-environment jsdom

/**
 * Opening a conversation and leaving before it has loaded still reads it.
 *
 * The opening pass marks what it can see, and it can see nothing until the
 * messages land - so opening a conversation and going straight back left it bold
 * in the rail. Leaving now catches the whole conversation up when the opening
 * pass never got to, and does nothing extra when it did.
 */

import { act } from "react";
import { MessagesWrapper } from "../setup/i18n";
import { ChannelView } from "@/app/(app)/chat/channel-view";
import { cleanup, render, screen } from "@testing-library/react";
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
let channels: (typeof dm)[] = [dm];
let loaded = true;
/** The read of the conversation, held open so the test decides when it lands. */
let landRead: (() => void) | null = null;
const markRead = vi.fn(async () => ({}));
const markChannelsRead = vi.fn(async () => ({}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
    useSearchParams: () => new URLSearchParams()
}));

vi.mock("@/app/(app)/chat/emoji-actions", () => ({
    spaceEmojiAction: async () => ({ list: { emoji: [], manages: false } })
}));
vi.mock("@/app/(app)/chat/actions", () => ({
    listScheduledAction: async () => ({ scheduled: [] }),
    readChannelAction: () =>
        new Promise((resolve) => {
            landRead = () => resolve({ page: { messages: opened, olderThan: null, newerThan: null } });
        }),
    readSinceAction: async () => ({ page: { messages: [] } }),
    markReadAction: (input: unknown) => markRead(input),
    markChannelsReadAction: (input: unknown) => markChannelsRead(input),
    receiptsAction: async () => ({ receipts: {} }),
    readThreadAction: async () => ({ messages: [] }),
    profileAction: async () => ({}),
    voicePresenceAction: async () => ({ inRoom: {} })
}));

vi.mock("@/app/(app)/chat/meeting-actions", () => ({ liveCallAction: async () => null }));

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
        refresh: () => undefined,
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
vi.mock("@/app/(app)/chat/channel-header", () => ({ ChannelHeader: () => null }));
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
    landRead = null;
    markRead.mockClear();
    markChannelsRead.mockClear();
    Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
    cleanup();
});

describe("leaving a conversation at once", () => {
    it("marks it read when it is left before its messages arrive", () => {
        const { unmount } = render(<ChannelView channelId="c1" />, { wrapper: MessagesWrapper });
        expect(markRead).not.toHaveBeenCalled();
        unmount();
        expect(markChannelsRead).toHaveBeenCalledWith({ channelIds: ["c1"] });
    });

    it("marks nothing more when the opening pass already read it", async () => {
        const { unmount } = render(<ChannelView channelId="c1" />, { wrapper: MessagesWrapper });
        await act(async () => landRead?.());
        expect(await screen.findByText("m1")).toBeTruthy();
        expect(markRead).toHaveBeenCalled();
        unmount();
        expect(markChannelsRead).not.toHaveBeenCalled();
    });

    it("marks nothing for a tab that was never shown", () => {
        Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
        const { unmount } = render(<ChannelView channelId="c1" />, { wrapper: MessagesWrapper });
        unmount();
        expect(markChannelsRead).not.toHaveBeenCalled();
        Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    });
});
