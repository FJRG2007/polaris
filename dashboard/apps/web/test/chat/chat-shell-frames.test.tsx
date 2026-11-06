// @vitest-environment jsdom

/**
 * What the live frames make the conversation list ask for.
 *
 * What is pinned: somebody talking asks for the conversations alone - the
 * order and the unread marks are all a message can move - while a change in
 * who is in what asks for everything, spaces and headings included. Somebody
 * else catching up asks for the conversations only where it can move a tick:
 * a row ending on the reader's own message, with ticks, not yet read.
 */

import { MessagesWrapper } from "../setup/i18n";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let onFrame: ((frame: unknown) => void) | null = null;
let full = 0;
let channelsOnly = 0;
let rows: unknown[] = [];

vi.mock("next/navigation", () => ({ usePathname: () => "/chat" }));
vi.mock("@/app/(app)/chat/server-rail", () => ({ ServerRail: () => null }));
vi.mock("@/app/(app)/chat/chat-sidebar", () => ({ ChatSidebar: () => null }));
// The lock provider sits in the shell now; its server reads are not under test here.
vi.mock("@/app/(app)/chat/lock-dialogs", () => ({
    ChatLockProvider: ({ children }: { children: unknown }) => children
}));
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({
    useChatStream: (handler: (frame: unknown) => void) => {
        onFrame = handler;
    }
}));
vi.mock("@/app/(app)/chat/use-chat-pane", () => ({
    useChatPane: () => ({
        drawn: 256,
        ceiling: 480,
        measure: () => undefined,
        resize: () => undefined,
        reset: () => undefined
    })
}));
vi.mock("@/app/(app)/chat/chat-context", () => ({
    ChatProvider: ({ children }: { children: unknown }) => children,
    useChat: () => ({
        viewerId: "ada",
        channels: rows,
        refresh: () => {
            full += 1;
        },
        refreshChannels: () => {
            channelsOnly += 1;
        }
    })
}));

const { ChatShell } = await import("@/app/(app)/chat/chat-shell");

const may = { spaces: true, groups: true, attach: true, call: false, meetings: false };

beforeEach(() => {
    onFrame = null;
    full = 0;
    channelsOnly = 0;
    rows = [
        { id: "c1", last: { authorId: "ada", receipts: true, read: false } },
        { id: "c2", last: { authorId: "ada", receipts: true, read: true } },
        { id: "c3", last: { authorId: "grace", receipts: false, read: false } }
    ];
    render(
        <ChatShell viewerId="ada" viewerName="Ada" orgId={null} orgName={null} may={may}>
            {null}
        </ChatShell>,
        { wrapper: MessagesWrapper }
    );
});

afterEach(cleanup);

describe("a frame arriving", () => {
    it("asks for the conversations alone when somebody talked", () => {
        onFrame?.({ kind: "posted", seq: 1, channels: ["c1"] });
        expect(channelsOnly).toBe(1);
        expect(full).toBe(0);
    });

    it("asks for the conversations alone when this reader caught up elsewhere", () => {
        onFrame?.({ kind: "read", channelId: "c1", userId: "ada" });
        expect(channelsOnly).toBe(1);
        expect(full).toBe(0);
    });

    it("asks for the list alone when somebody else caught up under an unread tick", () => {
        onFrame?.({ kind: "read", channelId: "c1", userId: "grace" });
        expect(channelsOnly).toBe(1);
        expect(full).toBe(0);
    });

    it("asks for nothing when somebody else's read cannot move a tick", () => {
        onFrame?.({ kind: "read", channelId: "c2", userId: "grace" });
        onFrame?.({ kind: "read", channelId: "c3", userId: "grace" });
        expect(channelsOnly + full).toBe(0);
    });

    it("asks for everything when who is in what changed", () => {
        onFrame?.({ kind: "channels" });
        expect(full).toBe(1);
        expect(channelsOnly).toBe(0);
    });
});
