// @vitest-environment jsdom
/**
 * What an open conversation asks the server on its own, counted.
 *
 * A tab left on a conversation sent a server action every five seconds for as
 * long as it stayed open - 1634 in two and a half hours, measured - because a
 * message drawn as sending that never settled read the conversation again on a
 * fixed timer, hidden or not. And every read or delivery frame from another
 * member asked for the ticks again, one server action per frame.
 */

import { MessagesWrapper } from "../setup/i18n";
import { ChannelView } from "@/app/(app)/chat/channel-view";
import { render, cleanup, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MINE = {
    id: "m1",
    channelId: "c1",
    authorId: "ada",
    authorName: "Ada",
    body: "already sent",
    createdAt: new Date("2026-01-01T10:00:00Z").toISOString(),
    receipt: "sent",
    reactions: [],
    attachments: []
};

const state = vi.hoisted(() => ({
    reads: 0,
    receipts: 0,
    handler: null as ((frame: unknown) => void) | null
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({
        push: () => undefined,
        refresh: () => undefined,
        replace: () => undefined
    }),
    useSearchParams: () => new URLSearchParams()
}));

vi.mock("@/app/(app)/chat/emoji-actions", () => ({
    spaceEmojiAction: async () => ({ list: { emoji: [], manages: false } })
}));
// The chat lock reaches the server; nothing here is locked.
vi.mock("@/app/(app)/chat/lock-actions", () => ({
    lockStateAction: async () => ({ hasCode: false, hideLocked: false })
}));
vi.mock("@/components/step-up-dialog", () => ({ StepUpDialog: () => null }));
vi.mock("@/app/(app)/chat/actions", () => ({
    // Jumping to a message out of the window asks for the page around it.
    readAroundAction: async () => ({ error: "" }),
    listScheduledAction: async () => ({ scheduled: [] }),
    readChannelAction: async () => {
        state.reads += 1;
        return { page: { messages: [MINE], olderThan: null, newerThan: null } };
    },
    readSinceAction: async () => {
        state.reads += 1;
        return { page: { messages: [] } };
    },
    markReadAction: async () => ({}),
    markChannelsReadAction: async () => ({}),
    receiptsAction: async () => {
        state.receipts += 1;
        return { receipts: {} };
    },
    readThreadAction: async () => ({ messages: [] })
}));
// One message written on this device that the server never took back: it
// stays drawn as sending, which is what keeps the screen reading again.
vi.mock("@/app/(app)/chat/outbox", () => ({
    readOutbox: async () => [
        { key: "k1", channelId: "c1", body: "never settles", state: "pending", attempts: 0, createdAt: new Date().toISOString() }
    ],
    subscribeOutbox: () => () => undefined,
    flushOutbox: () => undefined,
    enqueue: async () => false
}));

vi.mock("@/app/(app)/chat/meeting-actions", () => ({
    liveCallAction: async () => {
        state.asked += 1;
        return state.live;
    },
    startCallAction: async () => ({ meetingId: "m1" })
}));

vi.mock("@/app/(app)/chat/use-chat-stream", () => ({
    useChatStream: (handler: (frame: unknown) => void) => {
        state.handler = handler;
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
        friends: new Set<string>(),
        refresh: () => undefined,
        viewerId: "ada",
        viewerName: "Ada",
        may: { spaces: true, groups: true, attach: true, call: true, meetings: true },
        orgId: null,
        orgName: null,
        callsOff: false,
        channels: [
            {
                id: "c1",
                name: "Deploys",
                kind: "group",
                spaceId: null,
                archived: false,
                unreadCount: 0,
                mayModerate: false,
                gameLinks: []
            }
        ],
        spaces: [],
        categories: [],
        activeSpaceId: null,
        setActiveSpaceId: () => undefined,
        loaded: true,
        rulesFor: () => ({
            maxAttachments: 10,
            maxAttachmentMib: 25,
            maxAttachmentBytes: 25 * 1024 * 1024,
            deleteLeavesTrace: false,
            editWindowMinutes: 0
        })
    })
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

vi.mock("@/app/(app)/chat/composer", () => ({ Composer: () => null }));
vi.mock("@/app/(app)/chat/call-room", () => ({ CallRoom: () => null }));
vi.mock("@/app/(app)/chat/thread-panel", () => ({ ThreadPanel: () => null }));
vi.mock("@/app/(app)/chat/search-panel", () => ({ SearchPanel: () => null }));
vi.mock("@/app/(app)/chat/forward-dialog", () => ({ ForwardDialog: () => null }));
vi.mock("@/app/(app)/chat/message-list", () => ({ MessageList: () => <ul /> }));
vi.mock("@/app/(app)/chat/channel-header", () => ({ ChannelHeader: () => null }));
vi.mock("@/app/(app)/chat/members-panel", () => ({
    ChannelMembers: () => null,
    useMembersPanel: () => ({ open: false, show: () => undefined, hide: () => undefined })
}));


async function settle(): Promise<void> {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
    });
}

function setVisibility(value: DocumentVisibilityState): void {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
    state.reads = 0;
    state.receipts = 0;
    state.handler = null;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ live: null })));
    Element.prototype.scrollIntoView = () => undefined;
    vi.useFakeTimers({ shouldAdvanceTime: false });
});
afterEach(() => {
    cleanup();
    setVisibility("visible");
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

async function open(): Promise<void> {
    render(<ChannelView channelId="c1" />, { wrapper: MessagesWrapper });
    for (let step = 0; step < 5; step += 1) await settle();
}

async function pass(ms: number): Promise<void> {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

describe("a conversation left open with a message that never settles", () => {
    it("reads again less and less often, not every five seconds", async () => {
        await open();
        const before = state.reads;
        await pass(10 * 60_000);
        // 5, 10, 20, 40 and then once a minute: 13 reads in ten minutes, where a
        // fixed five-second timer made 120.
        expect(state.reads - before).toBeLessThanOrEqual(14);
        expect(state.reads - before).toBeGreaterThan(0);
    });

    it("asks nothing while the tab is hidden, and reads at once on return", async () => {
        await open();
        setVisibility("hidden");
        const before = state.reads;
        await pass(30 * 60_000);
        expect(state.reads).toBe(before);
        await act(async () => {
            setVisibility("visible");
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(state.reads).toBe(before + 1);
    });
});

describe("read and delivery frames from the other members", () => {
    it("ask for the ticks once for a run of them, not once per frame", async () => {
        await open();
        expect(state.handler).toBeTruthy();
        await act(async () => {
            for (let member = 0; member < 30; member += 1) {
                state.handler?.({ kind: member % 2 ? "read" : "delivered", channelId: "c1", userId: `u${member}` });
            }
            await vi.advanceTimersByTimeAsync(1000);
        });
        expect(state.receipts).toBe(1);
        // A later frame is still answered: the ticks stay live.
        await act(async () => {
            state.handler?.({ kind: "read", channelId: "c1", userId: "bo" });
            await vi.advanceTimersByTimeAsync(1000);
        });
        expect(state.receipts).toBe(2);
    });
});
