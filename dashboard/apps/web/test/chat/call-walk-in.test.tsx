// @vitest-environment jsdom

/**
 * Opening a voice channel walks into it - unless this browser is already
 * holding a call somewhere else.
 *
 * `enter` replaces whatever this browser was in, so walking in on sight while
 * already on a call would silently hang up the conversation being had, with
 * no press and nothing said about it. The guard is what `session` is for:
 * while a call is held, opening a different voice channel to look inside must
 * not touch it.
 */

import { render } from "@testing-library/react";
import { ChannelView } from "@/app/(app)/chat/channel-view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let session: { channelId: string; meetingId: string } | null = null;
let started: string[] = [];

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
    useSearchParams: () => new URLSearchParams()
}));

vi.mock("@/app/(app)/chat/actions", () => ({
    readChannelAction: async () => ({ page: { messages: [], olderThan: null, newerThan: null } }),
    readSinceAction: async () => ({ page: { messages: [] } }),
    markReadAction: async () => ({}),
    receiptsAction: async () => ({ receipts: {} }),
    readThreadAction: async () => ({ messages: [] })
}));

vi.mock("@/app/(app)/chat/meeting-actions", () => ({
    liveCallAction: async () => null,
    startCallAction: async (channelId: string) => {
        started.push(channelId);
        return { meetingId: `meeting-${channelId}` };
    }
}));

vi.mock("@/app/(app)/chat/use-chat-stream", () => ({
    useChatStream: () => undefined
}));

vi.mock("@/app/(app)/account/privacy/actions", () => ({
    listBlockedAction: async () => ({ people: [] }),
    blockPersonAction: async () => ({}),
    unblockPersonAction: async () => ({})
}));

vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({
        blocked: new Set<string>(),
        refresh: () => undefined,
        viewerId: "ada",
        viewerName: "Ada",
        may: { spaces: true, groups: true, attach: true, call: true },
        orgId: null,
        orgName: null,
        callsOff: false,
        channels: [
            {
                id: "c1",
                name: "General voice",
                kind: "voice",
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

const entered: unknown[] = [];

vi.mock("@/app/(app)/chat/call-session", () => ({
    useCallHold: () => ({
        call: null,
        session,
        enter: (...args: unknown[]) => entered.push(args),
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
    session = null;
    started = [];
    entered.length = 0;
    Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("opening a voice channel", () => {
    it("walks in on its own when this browser holds no call", async () => {
        render(<ChannelView channelId="c1" />);

        await vi.waitFor(() =>
            expect(entered).toEqual([
                [{ meetingId: "meeting-c1", channelId: "c1", title: "General voice" }, false]
            ])
        );
        expect(started).toEqual(["c1"]);
    });

    it("does not touch a call already held somewhere else", async () => {
        session = { channelId: "elsewhere", meetingId: "m-elsewhere" };
        render(<ChannelView channelId="c1" />);

        // Give every effect and microtask a turn to run, then confirm it never
        // started a call.
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(started).toEqual([]);
        expect(entered).toEqual([]);
    });
});
