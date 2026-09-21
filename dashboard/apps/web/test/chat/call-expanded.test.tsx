// @vitest-environment jsdom
/**
 * A call in a direct message, expanded to the whole column.
 *
 * Expanding puts the conversation away behind the call rather than taking it
 * down - what somebody was typing is still there when it shrinks again - and
 * the band's own divider goes with it, since there is nothing left to divide.
 */

import { ChannelView } from "@/app/(app)/chat/channel-view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const state = vi.hoisted(() => ({
    kind: "group" as "group" | "voice" | "text",
    live: null as { meetingId: string; count: number; people: unknown[] } | null,
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
        session: { meetingId: "m1", channelId: "c1", title: "Call" },
        enter: () => undefined,
        leave: () => undefined,
        withVideo: false
    })
}));

vi.mock("@/app/(app)/chat/composer", () => ({ Composer: () => null }));
// The room itself is somebody else's test; what is pinned here is what the
// conversation does when it is told to expand.
vi.mock("@/app/(app)/chat/call-room", () => ({
    CallRoom: ({
        expanded,
        onExpand
    }: {
        expanded?: boolean;
        onExpand?: (expanded: boolean) => void;
    }) =>
        onExpand ? (
            <button type="button" onClick={() => onExpand(!expanded)}>
                {expanded ? "Shrink the call" : "Expand the call"}
            </button>
        ) : null
}));
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

describe("expanding a call in a group", () => {
    it("puts the conversation away behind the call, and brings it back", async () => {
        render(<ChannelView channelId="c1" />);
        const messages = await screen.findByText("Nothing here yet.");
        expect(messages.closest(".hidden")).toBeNull();
        expect(screen.getByRole("separator", { name: "Call height" })).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Expand the call" }));
        // Still mounted, only hidden.
        expect(messages.isConnected).toBe(true);
        expect(messages.closest(".hidden")).not.toBeNull();
        expect(screen.queryByRole("separator", { name: "Call height" })).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Shrink the call" }));
        expect(messages.closest(".hidden")).toBeNull();
    });

    it("is offered in a channel too, where a capped call used to be the end of it", async () => {
        // Why it is not direct messages only: the reason anybody asks is a picture
        // they are trying to read, and that happens in a channel's call as much as
        // in a group's. Without this the size above the cap was the whole display.
        state.kind = "text";
        render(<ChannelView channelId="c1" />);
        const messages = await screen.findByText("Nothing here yet.");
        fireEvent.click(screen.getByRole("button", { name: "Expand the call" }));
        expect(messages.isConnected).toBe(true);
        expect(messages.closest(".hidden")).not.toBeNull();
    });

    it("is not offered in a voice room, which is the column already", async () => {
        state.kind = "voice";
        render(<ChannelView channelId="c1" />);
        await screen.findByText("Nothing here yet.");
        expect(screen.queryByRole("button", { name: "Expand the call" })).toBeNull();
    });
});
