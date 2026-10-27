// @vitest-environment jsdom

/**
 * A call ringing in a group somebody has open: the stage over the messages
 * rings, its buttons join the way the rest of the screen does, and declining
 * folds it into the line that says the call is still running.
 */
import { MessagesWrapper } from "../setup/i18n";
import { ChannelView } from "@/app/(app)/chat/channel-view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent, cleanup, within } from "@testing-library/react";

const state = vi.hoisted(() => ({
    kind: "group" as "group" | "voice",
    live: {
        meetingId: "m1",
        count: 2,
        people: [
            {
                id: "seat-bo",
                userId: "bo",
                name: "Bo Diaz",
                muted: false,
                deafened: false,
                streaming: true
            },
            {
                id: "seat-cat",
                userId: "cat",
                name: "Cat Ruiz",
                muted: true,
                deafened: false,
                streaming: false
            }
        ]
    } as { meetingId: string; count: number; people: unknown[] } | null,
    started: [] as string[],
    entered: [] as boolean[],
    frames: [] as ((frame: unknown, context: { owner: boolean }) => void)[]
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
    liveCallAction: async () => state.live,
    startCallAction: async (channelId: string) => {
        state.started.push(channelId);
        return { meetingId: "m1" };
    }
}));

vi.mock("@/app/(app)/chat/use-chat-stream", () => ({
    useChatStream: (handler: (frame: unknown, context: { owner: boolean }) => void) => {
        state.frames.push(handler);
    }
}));
vi.mock("@/lib/call-sounds", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    playCallSound: () => undefined
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
                kind: state.kind,
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
        enter: (_session: unknown, withVideo: boolean) => void state.entered.push(withVideo),
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

beforeEach(() => {
    state.kind = "group";
    state.started = [];
    state.entered = [];
    state.frames = [];
    state.live!.meetingId = "m1";
    // This runtime's jsdom has no local storage of its own, and what a call put
    // away is remembered in one. Written out rather than mocked away: surviving
    // the screen being built again is the whole point of it.
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
});
afterEach(cleanup);

/** The newest handler each mounted hook gave the stream, called with one frame. */
function send(frame: unknown): void {
    act(() => {
        for (const handler of state.frames.slice()) handler(frame, { owner: true });
    });
}

const ringing = {
    kind: "call",
    state: "ringing",
    channelId: "c1",
    meetingId: "m1",
    count: 2,
    userId: "bo",
    name: "Bo Diaz"
};

describe("a group call ringing at somebody reading the group", () => {
    it("rings on the stage, and joins with the camera from it", async () => {
        render(<ChannelView channelId="c1" />, { wrapper: MessagesWrapper });
        await screen.findByRole("region", { name: "Call in progress" });

        send(ringing);

        const stage = await screen.findByRole("region", { name: "Incoming call" });
        expect(within(stage).getByText("Bo Diaz is calling")).toBeTruthy();
        expect(within(stage).getAllByTestId("ring-pulse")).toHaveLength(1);
        expect(within(stage).getByLabelText("Microphone off")).toBeTruthy();

        fireEvent.click(within(stage).getByRole("button", { name: "Join with video" }));
        await vi.waitFor(() => expect(state.started).toEqual(["c1"]));
        await vi.waitFor(() => expect(state.entered).toEqual([true]));
    });

    it("joins by voice alone from the phone button", async () => {
        render(<ChannelView channelId="c1" />, { wrapper: MessagesWrapper });
        await screen.findByRole("region", { name: "Call in progress" });
        send(ringing);

        const stage = await screen.findByRole("region", { name: "Incoming call" });
        fireEvent.click(within(stage).getByRole("button", { name: "Join" }));
        await vi.waitFor(() => expect(state.entered).toEqual([false]));
    });

    it("declining folds the stage into the line, still one press from joining", async () => {
        render(<ChannelView channelId="c1" />, { wrapper: MessagesWrapper });
        await screen.findByRole("region", { name: "Call in progress" });
        send(ringing);

        const stage = await screen.findByRole("region", { name: "Incoming call" });
        fireEvent.click(within(stage).getByRole("button", { name: "Decline" }));

        await vi.waitFor(() =>
            expect(screen.queryByRole("region", { name: "Incoming call" })).toBeNull()
        );
        expect(screen.queryByRole("region", { name: "Call in progress" })).toBeNull();
        expect(screen.getByText("2 people in the call")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Join" })).toBeTruthy();
        expect(state.started).toEqual([]);
    });

    it("shows a call in progress without ringing or a decline", async () => {
        render(<ChannelView channelId="c1" />, { wrapper: MessagesWrapper });
        const stage = await screen.findByRole("region", { name: "Call in progress" });
        expect(within(stage).queryByTestId("ring-pulse")).toBeNull();
        expect(within(stage).queryByRole("button", { name: "Decline" })).toBeNull();
        expect(within(stage).getByRole("button", { name: "Join with video" })).toBeTruthy();
    });
});
