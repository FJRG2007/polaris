// @vitest-environment jsdom

/**
 * Pressing a voice channel walks into it. Arriving at one does not.
 *
 * The press travels in the address (`?join=1`) and is taken out of it as soon as
 * it is acted on, so the two cases that look identical to the screen stay apart:
 * somebody who pressed the room's name in the rail is put into the call, and
 * somebody whose browser merely has that room on screen - a reload, a second
 * tab, a window the browser reopened - is not. Read off the screen instead, a
 * reload put people back into calls they had just left, with a microphone open
 * and no press anywhere.
 *
 * And never on top of a call already being held. `enter` replaces whatever this
 * browser was in, so walking in while on a call would silently hang up the
 * conversation being had. The guard is what `session` is for.
 */

import { render } from "@testing-library/react";
import { ChannelView } from "@/app/(app)/chat/channel-view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let session: { channelId: string; meetingId: string } | null = null;
let started: string[] = [];
let params = new URLSearchParams();
let replaced: string[] = [];

vi.mock("next/navigation", () => ({
    useRouter: () => ({
        push: () => undefined,
        refresh: () => undefined,
        replace: (href: string) => replaced.push(href)
    }),
    useSearchParams: () => params
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
    replaced = [];
    params = new URLSearchParams("join=1");
    entered.length = 0;
    Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
    vi.clearAllMocks();
});

/** Long enough for every effect and microtask to have had its turn. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("pressing a voice channel", () => {
    it("walks in when this browser holds no call", async () => {
        render(<ChannelView channelId="c1" />);

        await vi.waitFor(() =>
            expect(entered).toEqual([
                [{ meetingId: "meeting-c1", channelId: "c1", title: "General voice" }, false]
            ])
        );
        expect(started).toEqual(["c1"]);
    });

    it("takes the press out of the address, so a reload does not repeat it", async () => {
        render(<ChannelView channelId="c1" />);

        await vi.waitFor(() => expect(replaced).toEqual(["/chat/c/c1"]));
    });

    it("does not touch a call already held somewhere else", async () => {
        session = { channelId: "elsewhere", meetingId: "m-elsewhere" };
        render(<ChannelView channelId="c1" />);

        await settle();
        expect(started).toEqual([]);
        expect(entered).toEqual([]);
    });
});

describe("arriving at a voice channel without pressing it", () => {
    it("opens no microphone", async () => {
        // What a reload, a second tab or a restored window looks like from here:
        // the room on screen, and nothing in the address saying anybody asked to
        // be in it.
        params = new URLSearchParams();
        render(<ChannelView channelId="c1" />);

        await settle();
        expect(started).toEqual([]);
        expect(entered).toEqual([]);
        expect(replaced).toEqual([]);
    });
});
