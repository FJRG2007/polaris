// @vitest-environment jsdom

/**
 * Opening a conversation before the list of conversations has arrived.
 *
 * Which is the ordinary way in: the channel this screen is drawing comes from a
 * list that is still being fetched, so the first paint is a skeleton and the
 * channel turns up a moment later. The defect this pins down is what that does to
 * the hooks - a skeleton that returns early runs fewer of them than the screen
 * behind it, and React ends the render with "Rendered more hooks than during the
 * previous render" rather than drawing the conversation at all.
 *
 * It is asserted as "the conversation appears", because that is all anybody
 * outside sees: the crash took the whole view down on every fresh load, and the
 * test for it is simply that the second render happens.
 */

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
    others: [{ id: "grace", name: "Grace" }]
};

/** What the chat context has, which is nothing until the list lands. */
let channels: (typeof dm)[] = [];
let loaded = false;

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
    useSearchParams: () => new URLSearchParams()
}));

vi.mock("@/app/(app)/chat/actions", () => ({
    listScheduledAction: async () => ({ scheduled: [] }),
    readChannelAction: async () => ({
        page: { messages: opened, olderThan: null, newerThan: null }
    }),
    readSinceAction: async () => ({ page: { messages: [] } }),
    markReadAction: async () => ({}),
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
    channels = [];
    loaded = false;
    Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
    cleanup();
});

describe("a conversation whose channel has not arrived yet", () => {
    it("draws it once it does, rather than throwing on the render that has it", async () => {
        const { rerender } = render(<ChannelView channelId="c1" />);
        // Nothing to draw yet, which is the render that decides how many hooks
        // this component has for the rest of its life.
        expect(screen.queryByText("m1")).toBeNull();

        channels = [dm];
        loaded = true;
        rerender(<ChannelView channelId="c1" />);

        expect(await screen.findByText("m1")).toBeTruthy();
    });
});
