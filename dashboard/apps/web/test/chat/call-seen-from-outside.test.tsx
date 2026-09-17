// @vitest-environment jsdom
/**
 * A call somebody has not joined, seen from the conversation.
 *
 * It used to be one line of text above the messages, so a group where two people
 * were talking looked exactly like a group where nothing was happening. The
 * faces are drawn instead - the same ones the call itself draws - with the way
 * in beside them, and they can be put away for the call they are about without
 * hiding the next one.
 *
 * And in a voice room, the people in it are listed the way Polaris lists members
 * everywhere else: a column of rows, a face and a name, rather than a line of
 * chips.
 */

import { ChannelView } from "@/app/(app)/chat/channel-view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";

const state = vi.hoisted(() => ({
    kind: "group" as "group" | "voice",
    live: {
        meetingId: "m1",
        count: 2,
        people: [
            { id: "seat-bo", userId: "bo", name: "Bo Diaz", muted: false, deafened: false },
            { id: "seat-cat", userId: "cat", name: "Cat Ruiz", muted: true, deafened: false }
        ]
    } as { meetingId: string; count: number; people: unknown[] } | null,
    started: [] as string[]
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({
        push: () => undefined,
        refresh: () => undefined,
        replace: () => undefined
    }),
    useSearchParams: () => new URLSearchParams()
}));

vi.mock("@/app/(app)/chat/actions", () => ({
    listScheduledAction: async () => ({ scheduled: [] }),
    readChannelAction: async () => ({ page: { messages: [], olderThan: null, newerThan: null } }),
    readSinceAction: async () => ({ page: { messages: [] } }),
    markReadAction: async () => ({}),
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
                mayModerate: false
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

beforeEach(() => {
    state.kind = "group";
    state.started = [];
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

describe("a call running in a group somebody is only reading", () => {
    it("draws the people in it, with the way in", async () => {
        render(<ChannelView channelId="c1" />);

        const panel = await screen.findByRole("region", { name: "Call in progress" });
        expect(within(panel).getByText("2 people in the call")).toBeTruthy();
        expect(within(panel).getByText("Bo Diaz")).toBeTruthy();
        expect(within(panel).getByText("Cat Ruiz")).toBeTruthy();
        // The one that says somebody cannot be heard, drawn on their face.
        expect(within(panel).getByLabelText("Microphone off")).toBeTruthy();

        fireEvent.click(within(panel).getByRole("button", { name: "Join" }));
        expect(state.started).toEqual(["c1"]);
    });

    it("can be put away, and brought back", async () => {
        render(<ChannelView channelId="c1" />);

        const panel = await screen.findByRole("region", { name: "Call in progress" });
        fireEvent.click(within(panel).getByRole("button", { name: "Hide the call" }));

        // The conversation is back, and the call has not been forgotten: the
        // line that is left is what says it is still running.
        expect(screen.queryByRole("region", { name: "Call in progress" })).toBeNull();
        expect(screen.getByText("2 people in the call")).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Show" }));
        expect(await screen.findByRole("region", { name: "Call in progress" })).toBeTruthy();
    });

    it("stays put away when the conversation is opened again", async () => {
        render(<ChannelView channelId="c1" />);
        const panel = await screen.findByRole("region", { name: "Call in progress" });
        fireEvent.click(within(panel).getByRole("button", { name: "Hide the call" }));

        // Opening another conversation and coming back - or reloading - builds
        // this screen from nothing, which is where a decision held in component
        // state was lost.
        cleanup();
        render(<ChannelView channelId="c1" />);

        expect(await screen.findByText("2 people in the call")).toBeTruthy();
        expect(screen.queryByRole("region", { name: "Call in progress" })).toBeNull();
    });

    it("shows the next call, which nobody put away", async () => {
        render(<ChannelView channelId="c1" />);
        const panel = await screen.findByRole("region", { name: "Call in progress" });
        fireEvent.click(within(panel).getByRole("button", { name: "Hide the call" }));

        cleanup();
        state.live!.meetingId = "m2";
        render(<ChannelView channelId="c1" />);

        expect(await screen.findByRole("region", { name: "Call in progress" })).toBeTruthy();
    });
});

describe("a voice room somebody has not walked into", () => {
    it("lists the people in it as rows, the way members are listed elsewhere", async () => {
        state.kind = "voice";
        render(<ChannelView channelId="c1" />);

        const list = await screen.findByRole("list", { name: "In Deploys" });
        const rows = within(list).getAllByRole("listitem");
        expect(rows).toHaveLength(2);
        expect(within(rows[0]!).getByText("Bo Diaz")).toBeTruthy();
        expect(within(rows[1]!).getByText("Cat Ruiz")).toBeTruthy();
        expect(within(list).getByLabelText("Microphone off")).toBeTruthy();
    });
});
