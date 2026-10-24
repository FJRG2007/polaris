// @vitest-environment jsdom
/**
 * No member list beside a voice room somebody is standing in.
 *
 * The call already shows who is in it, and the chat beside it is a narrow
 * column: a roster there is a third thing in a space built for two. So in that
 * view neither the list nor the button that opens it is drawn - and everywhere
 * else both still are.
 */

import { MessagesWrapper } from "../setup/i18n";
import { ChannelView } from "@/app/(app)/chat/channel-view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const state = vi.hoisted(() => ({
    kind: "group" as "group" | "voice" | "text",
    inCall: true,
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
        session: state.inCall ? { meetingId: "m1", channelId: "c1", title: "Call" } : null,
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
vi.mock("@/app/(app)/chat/channel-header", () => ({
    ChannelHeader: ({ onMembers }: { onMembers?: () => void }) =>
        onMembers ? (
            <button type="button" onClick={onMembers}>
                Members
            </button>
        ) : null
}));
vi.mock("@/app/(app)/chat/members-panel", () => ({
    ChannelMembers: ({ open }: { open: boolean }) => (open ? <aside>Member list</aside> : null),
    useMembersPanel: () => ({ open: true, setOpen: () => undefined, toggle: () => undefined })
}));

beforeEach(() => {
    state.kind = "group";
    state.inCall = true;
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

describe("the member list beside a voice room", () => {
    it("is neither drawn nor offered while somebody is in the room's call", async () => {
        state.kind = "voice";
        render(<ChannelView channelId="c1" />, { wrapper: MessagesWrapper });
        await screen.findByText("Nothing here yet.");
        expect(screen.queryByText("Member list")).toBeNull();
        expect(screen.queryByRole("button", { name: "Members" })).toBeNull();
    });

    it("is still there in a voice channel nobody here has walked into", async () => {
        state.kind = "voice";
        state.inCall = false;
        render(<ChannelView channelId="c1" />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("Member list")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Members" })).toBeTruthy();
    });

    it("is still there in a text channel with a call in it", async () => {
        state.kind = "text";
        render(<ChannelView channelId="c1" />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("Member list")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Members" })).toBeTruthy();
    });
});
