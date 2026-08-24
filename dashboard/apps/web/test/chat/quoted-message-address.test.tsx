// @vitest-environment jsdom

/**
 * The address of a message, written rather than travelled to.
 *
 * Following a link to a message said in the conversation already open used to be
 * an ordinary navigation, and a navigation is what it cost: the screen unmounted,
 * the conversation was fetched again and every line of it was drawn a second
 * time, to end up at a message that was already in the document. The room the
 * reader was reading blinked away and came back.
 *
 * The scroll is the whole of the movement now. The address still names the
 * message - so a copied URL, a reload and a share all land on the line - it is
 * put there with the history API rather than by asking the router for the route,
 * which is the part that used to redraw everything.
 */

import userEvent from "@testing-library/user-event";
import { ChannelView } from "@/app/(app)/chat/channel-view";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

const opened = [message("m1", "grace"), message("m2", "ada")];
const pushed: string[] = [];
const replaced: string[] = [];

vi.mock("next/navigation", () => ({
    useRouter: () => ({
        push: (to: string) => pushed.push(to),
        replace: (to: string) => pushed.push(to),
        refresh: () => undefined
    }),
    useSearchParams: () => new URLSearchParams()
}));

vi.mock("@/app/(app)/chat/actions", () => ({
    // The conversation asks what this reader has waiting the moment it
    // opens. Nothing, here - but the module is mocked, so it has to be
    // said rather than assumed.
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
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({ useChatStream: () => undefined }));
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

vi.mock("@/app/(app)/chat/composer", () => ({ Composer: () => null }));
vi.mock("@/app/(app)/chat/call-room", () => ({ CallRoom: () => null }));
vi.mock("@/app/(app)/chat/thread-panel", () => ({ ThreadPanel: () => null }));
vi.mock("@/app/(app)/chat/search-panel", () => ({ SearchPanel: () => null }));
vi.mock("@/app/(app)/chat/forward-dialog", () => ({ ForwardDialog: () => null }));
// The list stands in for the quote card inside it: what is under test is what
// the screen does when one is pressed, not how the card draws itself.
vi.mock("@/app/(app)/chat/message-list", () => ({
    MessageList: ({
        messages,
        onJumpTo
    }: {
        messages: readonly { id: string }[];
        onJumpTo?: (messageId: string) => void;
    }) => (
        <ul>
            {messages.map((entry) => (
                <li key={entry.id} id={`message-${entry.id}`}>
                    {entry.id}
                    <button type="button" onClick={() => onJumpTo?.(entry.id)}>
                        quote of {entry.id}
                    </button>
                </li>
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

let scrolledTo: string[] = [];

beforeEach(() => {
    pushed.length = 0;
    replaced.length = 0;
    scrolledTo = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
        scrolledTo.push(this.id);
    };
    vi.spyOn(window.history, "replaceState").mockImplementation(
        (_state: unknown, _title: string, url?: string | URL | null) => {
            replaced.push(String(url));
        }
    );
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe("a message quoted from this same conversation", () => {
    it("puts the message in the address without asking the router for the route", async () => {
        const user = userEvent.setup();
        render(<ChannelView channelId="c1" />);
        await screen.findByText("m1");
        await user.click(screen.getByRole("button", { name: "quote of m1" }));
        expect(replaced).toEqual(["/chat/c/c1/m1"]);
        expect(pushed).toEqual([]);
    });

    it("scrolls to the line, which is what the navigation was for", async () => {
        const user = userEvent.setup();
        render(<ChannelView channelId="c1" />);
        await screen.findByText("m1");
        scrolledTo = [];
        await user.click(screen.getByRole("button", { name: "quote of m1" }));
        // The walk waits for a drawn frame before it looks for the line, the
        // same as one that arrived from outside: the page it needs may be the
        // one React has only just been handed.
        await waitFor(() => expect(scrolledTo).toContain("message-m1"));
    });
});
