// @vitest-environment jsdom

/**
 * Coming back to the live end of a conversation is a read.
 *
 * A reader part way up the history is told what arrived below them rather than
 * being dragged to it, and one press takes them there. The press is where this
 * went wrong: a window that was never trimmed only has to scroll, and scrolling
 * does not change the list - so nothing told the server anything, and the channel
 * somebody was looking straight at stayed bold in the rail until the next message
 * happened to arrive.
 *
 * Pinned through the button, because that is the shape of the bug: the list is
 * identical before and after, and the read still has to happen.
 */

import userEvent from "@testing-library/user-event";
import { ChannelView } from "@/app/(app)/chat/channel-view";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The conversation, oldest first, as the channel is drawn. */
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
        mine: authorId === "ada",
        preview: null,
        previewPending: false,
        receipt: null,
        createdAt: new Date(1_700_000_000_000).toISOString()
    };
}

const opened = [message("m1", "grace"), message("m2", "ada")];
let arrived: ReturnType<typeof message>[] = [];
let marked: { channelId: string; messageId: string }[] = [];
/** The live frames this screen is handed, kept so a test can push one. */
let onFrame: ((frame: unknown, context: { owner: boolean }) => void) | null = null;

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
    useSearchParams: () => new URLSearchParams()
}));

vi.mock("@/app/(app)/chat/actions", () => ({
    readChannelAction: async () => ({ page: { messages: opened, olderThan: null, newerThan: null } }),
    readSinceAction: async () => ({ page: { messages: arrived } }),
    markReadAction: async (input: { channelId: string; messageId: string }) => {
        marked.push(input);
        return {};
    },
    receiptsAction: async () => ({ receipts: {} }),
    readThreadAction: async () => ({ messages: [] })
}));

vi.mock("@/app/(app)/chat/meeting-actions", () => ({
    liveCallAction: async () => null
}));

vi.mock("@/app/(app)/chat/use-chat-stream", () => ({
    useChatStream: (handler: (frame: unknown, context: { owner: boolean }) => void) => {
        onFrame = handler;
    }
}));

vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({
        viewerId: "ada",
        viewerName: "Ada",
        may: { spaces: true, groups: true, attach: true, call: true },
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
                mayModerate: false
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

// The pieces around the list: each pulls in an editor, a call or a server action
// chain, and none of them is what this is about.
vi.mock("@/app/(app)/chat/composer", () => ({ Composer: () => null }));
vi.mock("@/app/(app)/chat/call-room", () => ({ CallRoom: () => null }));
vi.mock("@/app/(app)/chat/thread-panel", () => ({ ThreadPanel: () => null }));
vi.mock("@/app/(app)/chat/search-panel", () => ({ SearchPanel: () => null }));
vi.mock("@/app/(app)/chat/forward-dialog", () => ({ ForwardDialog: () => null }));
vi.mock("@/app/(app)/chat/message-list", () => ({
    MessageList: ({ messages }: { messages: readonly { id: string }[] }) => (
        <ul>
            {messages.map((entry) => (
                <li key={entry.id} id={`message-${entry.id}`}>
                    {entry.id}
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

/** jsdom has neither, and the list scrolls itself on every change. */
beforeEach(() => {
    arrived = [];
    marked = [];
    onFrame = null;
    Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

/** Put the reader part way up a conversation that is taller than the window. */
function readingUpwards(container: HTMLElement): HTMLElement {
    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto");
    if (!scroller) throw new Error("the list did not render");
    Object.defineProperty(scroller, "scrollHeight", { value: 4000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 800, configurable: true });
    scroller.scrollTop = 1000;
    return scroller;
}

describe("the way back to the newest message", () => {
    it("marks the conversation read, even though the list did not change", async () => {
        const user = userEvent.setup();
        const { container } = render(<ChannelView channelId="c1" />);
        await screen.findByText("m2");
        expect(marked).toEqual([{ channelId: "c1", messageId: "m2" }]);

        // Away from the live end, and past the window in which the list insists
        // on the bottom for itself.
        const scroller = readingUpwards(container);
        vi.setSystemTime(Date.now() + 5000);
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));

        // A message lands below the fold. The window is whole, so nothing is
        // trimmed and there is no page below to fetch.
        arrived = [message("m3", "grace")];
        onFrame?.({ kind: "posted", seq: 1, channels: ["c1"] }, { owner: true });
        const jump = await screen.findByText("1 new message");

        marked = [];
        await user.click(jump);
        expect(marked).toEqual([{ channelId: "c1", messageId: "m3" }]);
    });
});
