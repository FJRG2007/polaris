// @vitest-environment jsdom

/**
 * A message the reader just sent is drawn once.
 *
 * The sending tab is told about its own message like every other tab, and that
 * frame starts a catch-up. The send reloads the conversation too, and the two
 * cross: the catch-up asks what is newer than the message it held before the
 * reload, the reload puts the new message on screen, and the catch-up's answer -
 * the same message - arrives after it. Appended as it was, that drew the message
 * twice until the next reload.
 */

import { MessagesWrapper } from "../setup/i18n";
import { ChannelView } from "@/app/(app)/chat/channel-view";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function message(id: string, authorId: string) {
    return {
        id,
        channelId: "c1",
        authorId,
        authorName: authorId,
        authorAvatar: null,
        body: `message ${id}`,
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
        mine: authorId === "ada",
        preview: null,
        previewPending: false,
        receipt: null,
        createdAt: new Date(1_700_000_000_000).toISOString()
    };
}

type Message = ReturnType<typeof message>;

let newest: Message[] = [];
let since: Promise<{ page: { messages: Message[] } }> = Promise.resolve({ page: { messages: [] } });
let onFrame: ((frame: unknown, context: { owner: boolean }) => void) | null = null;
let onSend: ((body: string) => Promise<void>) | null = null;

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
    useSearchParams: () => new URLSearchParams()
}));

vi.mock("@/app/(app)/chat/actions", () => ({
    listScheduledAction: async () => ({ scheduled: [] }),
    readChannelAction: async () => ({
        page: { messages: newest, olderThan: null, newerThan: null }
    }),
    readSinceAction: () => since,
    sendAction: async () => ({ id: "m2" }),
    markReadAction: async () => ({}),
    receiptsAction: async () => ({ receipts: {} }),
    readThreadAction: async () => ({ messages: [] }),
    profileAction: async () => ({}),
    voicePresenceAction: async () => ({ inRoom: {} })
}));

vi.mock("@/app/(app)/chat/meeting-actions", () => ({ liveCallAction: async () => null }));

vi.mock("@/app/(app)/chat/use-chat-stream", () => ({
    useChatStream: (handler: (frame: unknown, context: { owner: boolean }) => void) => {
        onFrame = handler;
    }
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
        channels: [
            {
                id: "c1",
                name: "Grace",
                kind: "dm",
                spaceId: null,
                archived: false,
                unreadCount: 0,
                mayModerate: false,
                gameLinks: [],
                others: [{ id: "grace", name: "Grace" }]
            }
        ],
        spaces: [],
        categories: [],
        activeSpaceId: null,
        setActiveSpaceId: () => undefined,
        loaded: true,
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

vi.mock("@/app/(app)/chat/composer", () => ({
    Composer: (props: { onSend: (body: string) => Promise<void> }) => {
        onSend = props.onSend;
        return null;
    }
}));
vi.mock("@/app/(app)/chat/call-room", () => ({ CallRoom: () => null }));
vi.mock("@/app/(app)/chat/thread-panel", () => ({ ThreadPanel: () => null }));
vi.mock("@/app/(app)/chat/search-panel", () => ({ SearchPanel: () => null }));
vi.mock("@/app/(app)/chat/forward-dialog", () => ({ ForwardDialog: () => null }));
vi.mock("@/app/(app)/chat/message-list", () => ({
    MessageList: ({ messages }: { messages: readonly { id: string }[] }) => (
        <ul>
            {messages.map((entry, at) => (
                <li key={`${entry.id}-${at}`}>{entry.id}</li>
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
    newest = [message("m1", "grace")];
    onFrame = null;
    onSend = null;
    Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
    cleanup();
});

describe("the reader's own message", () => {
    it("is drawn once when its frame's catch-up answers after the send's reload", async () => {
        render(<ChannelView channelId="c1" />, { wrapper: MessagesWrapper });
        await screen.findByText("m1");
        await waitFor(() => expect(onSend).not.toBeNull());

        let answer: (value: { page: { messages: Message[] } }) => void = () => undefined;
        since = new Promise((resolve) => {
            answer = resolve;
        });
        await act(async () => {
            onFrame?.({ kind: "posted", seq: 1, channels: ["c1"] }, { owner: true });
        });

        newest = [message("m1", "grace"), message("m2", "ada")];
        await act(async () => {
            await onSend?.("hello");
        });
        expect(screen.getAllByText("m2")).toHaveLength(1);

        await act(async () => {
            answer({ page: { messages: [message("m2", "ada")] } });
            await since;
        });
        expect(screen.getAllByText("m2")).toHaveLength(1);
    });
});
