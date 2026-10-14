// @vitest-environment jsdom
/**
 * A member sitting in a voice room of the space shows it under their name.
 *
 * The line replaces their status while it lasts, names the room on hover, opens
 * it when pressed, and follows the stream: somebody walking out of the room
 * loses it without anybody reloading. A room the reader cannot see is never
 * named, even when a seat in it is reported.
 */

import { MessagesWrapper, withMessages } from "../setup/i18n";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    inRoom: {} as Record<string, unknown[]>,
    asked: [] as string[][],
    onFrame: null as ((frame: unknown) => void) | null
}));

const seat = (userId: string) => ({
    id: `seat-${userId}`,
    name: userId,
    userId,
    muted: false,
    deafened: false,
    streaming: false,
    serverMuted: false,
    serverDeafened: false
});

vi.mock("@/app/(app)/chat/actions", () => ({
    listRosterAction: async () => ({
        members: [
            { userId: "member-a", name: "Member A", role: "member", online: true },
            { userId: "member-b", name: "Member B", role: "member", online: true }
        ]
    }),
    voicePresenceAction: async (ids: string[]) => {
        state.asked.push(ids);
        return { inRoom: state.inRoom };
    },
    openDirectAction: async () => ({ id: "d1" })
}));
vi.mock("@/app/(app)/account/privacy/actions", () => ({
    blockPersonAction: async () => ({}),
    unblockPersonAction: async () => ({})
}));
vi.mock("@/app/(app)/account/report-actions", () => ({ reportPersonAction: async () => ({}) }));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({
    useChatStream: (handler: (frame: unknown) => void) => {
        state.onFrame = handler;
    }
}));
vi.mock("@/app/(app)/chat/use-wide-screen", () => ({
    WIDE_ENOUGH: "(min-width: 1024px)",
    useWideScreen: () => true
}));
vi.mock("@/components/presence-store", async (original) => ({
    ...(await original<typeof import("@/components/presence-store")>()),
    // Everybody has a status line, which the voice line must win over.
    usePresence: (id: string | null | undefined) =>
        id ? { status: "online", note: "Out for a walk", inCall: null, activity: [] } : null,
    useKnownPresence: () => new Map()
}));

const room = (id: string, name: string, spaceId: string, kind = "voice") => ({
    id,
    name,
    kind,
    spaceId,
    archived: false
});

vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({
        viewerId: "viewer",
        blocked: new Set<string>(),
        friends: new Set<string>(),
        spaces: [],
        // The reader's own list: one voice room of this space they can see.
        // "secret" is a room they have no row for.
        channels: [room("c1", "general", "s1", "text"), room("v1", "Lounge", "s1")],
        refresh: () => undefined
    })
}));

const { ChannelMembers } = await import("@/app/(app)/chat/members-panel");

const channel = {
    id: "c1",
    name: "general",
    kind: "text",
    spaceId: "s1",
    categoryId: null,
    archived: false,
    ownerId: null,
    unreadCount: 0,
    mayModerate: false,
    others: [],
    gameLinks: []
} as never;

function panel() {
    return render(
        <ChannelMembers
            channel={channel}
            open
            onOpenChange={() => undefined}
            onMention={() => undefined}
        />,
        { wrapper: MessagesWrapper }
    );
}

const rowOf = (name: string) =>
    screen.getByRole("button", { name: new RegExp(name) }).closest("li") as HTMLElement;

beforeEach(() => {
    state.asked = [];
    state.onFrame = null;
    state.inRoom = { v1: [seat("member-a")], secret: [seat("member-b")] };
    Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
    });
    Element.prototype.getBoundingClientRect = function () {
        return {
            width: 240,
            height: 600,
            top: 0,
            left: 0,
            right: 240,
            bottom: 600,
            x: 0,
            y: 0,
            toJSON: () => ({})
        };
    };
});
afterEach(cleanup);

describe("a member in voice", () => {
    it("shows In voice under their name instead of their status, linking to the room", async () => {
        panel();
        const link = await screen.findByRole("link", { name: "In voice: Lounge" });
        expect(link.getAttribute("href")).toBe("/chat/c/v1");
        expect(link.getAttribute("title")).toBe("In voice: Lounge");
        expect(link.textContent).toBe("In voice");
        expect(link.querySelector("svg")).toBeTruthy();
        expect(rowOf("Member A").textContent).not.toContain("Out for a walk");
        // Only the rooms of this space the reader can see were asked about.
        expect(state.asked[0]).toEqual(["v1"]);
    });

    it("never names a room the reader cannot see", async () => {
        panel();
        await screen.findByRole("link", { name: /Lounge/ });
        expect(screen.getAllByRole("link")).toHaveLength(1);
        expect(rowOf("Member B").textContent).toContain("Out for a walk");
        expect(rowOf("Member B").textContent).not.toContain("In voice");
    });

    it("follows somebody leaving the room off the stream", async () => {
        panel();
        await screen.findByRole("link", { name: /Lounge/ });
        state.inRoom = {};
        await act(async () => {
            state.onFrame?.({
                kind: "call",
                channelId: "v1",
                meetingId: "m1",
                state: "moved",
                count: 0
            });
        });
        expect(screen.queryByRole("link", { name: /Lounge/ })).toBeNull();
        expect(rowOf("Member A").textContent).toContain("Out for a walk");
    });

    it("reads short in Spanish", async () => {
        render(
            withMessages(
                <ChannelMembers
                    channel={channel}
                    open
                    onOpenChange={() => undefined}
                    onMention={() => undefined}
                />,
                "es-ES"
            )
        );
        const link = await screen.findByRole("link", { name: "En voz: Lounge" });
        expect(link.textContent).toBe("En voz");
    });
});
