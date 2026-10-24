// @vitest-environment jsdom
/**
 * Somebody leaves a call, seen from the conversation by people who are not in it.
 *
 * The faces outside a call are only ever corrected by a frame, and a browser
 * that went away without hanging up - a closed tab, a laptop shut, a network
 * that dropped, a hang-up request that never arrived - sends none. Its seat is
 * only let go of when something sweeps the room, and nothing did: the last
 * person out of a group call stayed drawn in it, beside a Join button, for
 * everybody reading the conversation until they reloaded the page.
 *
 * So a call drawn from outside is asked about again while it is on screen, and
 * that request is the one that sweeps the seat nobody is keeping.
 */

import { MessagesWrapper } from "../setup/i18n";
import { ChannelView } from "@/app/(app)/chat/channel-view";
import { render, screen, cleanup, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** One fixture person, alone in the call. */
const ALONE = {
    meetingId: "m1",
    count: 1,
    people: [
        {
            id: "seat-bo",
            userId: "bo",
            name: "Bo Diaz",
            muted: false,
            deafened: false,
            streaming: false
        }
    ]
};

const state = vi.hoisted(() => ({
    live: null as { meetingId: string; count: number; people: unknown[] } | null,
    asked: 0
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
vi.mock("@/app/(app)/chat/actions", () => ({
    listScheduledAction: async () => ({ scheduled: [] }),
    readChannelAction: async () => ({ page: { messages: [], olderThan: null, newerThan: null } }),
    readSinceAction: async () => ({ page: { messages: [] } }),
    markReadAction: async () => ({}),
    markChannelsReadAction: async () => ({}),
    receiptsAction: async () => ({ receipts: {} }),
    readThreadAction: async () => ({ messages: [] })
}));

vi.mock("@/app/(app)/chat/meeting-actions", () => ({
    liveCallAction: async () => {
        state.asked += 1;
        return state.live;
    },
    startCallAction: async () => ({ meetingId: "m1" })
}));

vi.mock("@/app/(app)/chat/use-chat-stream", () => ({ useChatStream: () => undefined }));
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

/** Let the screen's pending reads land. */
async function settle(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

beforeEach(() => {
    state.live = structuredClone(ALONE);
    state.asked = 0;
    const kept = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => kept.get(key) ?? null,
            setItem: (key: string, value: string) => void kept.set(key, value),
            removeItem: (key: string) => void kept.delete(key),
            clear: () => kept.clear()
        }
    });
    Element.prototype.scrollIntoView = () => undefined;
    // Only the intervals are faked, so the screen's own timeouts still let it
    // settle.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("the last person out of a call somebody is only reading", () => {
    it("stops being drawn in it without a reload", async () => {
        render(<ChannelView channelId="c1" />, { wrapper: MessagesWrapper });
        expect(await screen.findByRole("region", { name: "Call in progress" })).toBeTruthy();
        expect(screen.getByText("Bo Diaz")).toBeTruthy();

        // Their browser went away without a word, and asking the server now
        // sweeps the seat and finds the room empty. No frame says so.
        state.live = null;
        await act(async () => {
            vi.advanceTimersByTime(60_000);
        });
        await settle();

        expect(screen.queryByRole("region", { name: "Call in progress" })).toBeNull();
        expect(screen.queryByText("Bo Diaz")).toBeNull();
    });

    it("is not asked about on a timer while there is no call to draw", async () => {
        state.live = null;
        render(<ChannelView channelId="c1" />, { wrapper: MessagesWrapper });
        await settle();
        const before = state.asked;

        await act(async () => {
            vi.advanceTimersByTime(5 * 60_000);
        });
        await settle();

        expect(state.asked).toBe(before);
    });
});
