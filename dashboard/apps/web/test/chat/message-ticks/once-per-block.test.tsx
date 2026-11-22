// @vitest-environment jsdom

/**
 * A block of the reader's own messages carries one tick, under its last
 * message, as Instagram draws them: the newest read means the ones above were
 * read too. A message still waiting or one that failed keeps its own clock or
 * retry wherever it is, because those are things to act on, not receipts.
 */

import { MessagesWrapper } from "../../setup/i18n";
import type { Outgoing } from "@/app/(app)/chat/outgoing";
import type { ChatMessageView } from "@/lib/chat/messages";
import { ShortcutsProvider, ToastProvider } from "@polaris/ui";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/chat/actions", () => ({
    deleteMessageAction: async () => ({}),
    saveMediaAction: async () => ({}),
    unsaveMediaAction: async () => ({}),
    linkPreviewAction: async () => ({}),
    openDirectAction: async () => ({ id: "d1" })
}));
vi.mock("@/app/(app)/account/privacy/actions", () => ({
    listBlockedAction: async () => ({ people: [] }),
    blockPersonAction: async () => ({}),
    unblockPersonAction: async () => ({})
}));
vi.mock("@/app/(app)/account/report-actions", () => ({ reportPersonAction: async () => ({}) }));
vi.mock("@/app/(app)/chat/chat-context", () => ({
    ChatProvider: () => null,
    useChat: () => ({
        blocked: new Set<string>(),
        friends: new Set<string>(),
        channels: [],
        spaces: [],
        may: {},
        refresh: () => undefined
    })
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
    usePathname: () => "/chat"
}));

const { MessageList } = await import("@/app/(app)/chat/message-list");

beforeAll(() => {
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    Element.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

const MINUTE = 60;

function message(
    id: string,
    receipt: ChatMessageView["receipt"],
    seconds: number,
    authorId = "ada"
): ChatMessageView {
    return {
        id,
        channelId: "c1",
        authorId,
        authorName: authorId,
        kind: "text",
        body: `message ${id}`,
        parentId: null,
        replyCount: 0,
        lastReplyAt: null,
        edited: false,
        deleted: false,
        reactions: [],
        attachments: [],
        quote: null,
        starred: false,
        references: [],
        forwardable: true,
        link: null,
        preview: null,
        previewPending: false,
        receipt,
        createdAt: new Date(1_700_000_000_000 + seconds * 1000).toISOString()
    } as unknown as ChatMessageView;
}

function list(messages: readonly ChatMessageView[], outgoing?: readonly Outgoing[]) {
    return (
        <ShortcutsProvider overrides={{}}>
            <ToastProvider>
                <MessageList
                    messages={messages}
                    outgoing={outgoing}
                    viewerId="ada"
                    canPost
                    canModerate={false}
                    onReact={() => undefined}
                    onStar={() => undefined}
                    onForward={() => undefined}
                    onEdit={() => undefined}
                    onDelete={() => undefined}
                />
            </ToastProvider>
        </ShortcutsProvider>
    );
}

const TICK = /^(Sent|Delivered|Read)\. Open message information/;

/** Every tick drawn, top to bottom, as the stage it names and the row it sits in. */
function ticks(): string[] {
    return screen
        .queryAllByRole("button", { name: TICK })
        .map((button) => `${button.getAttribute("aria-label")!.split(".")[0]} ${button.closest("li")?.id}`);
}

describe("the tick under a block of the reader's own messages", () => {
    it("is drawn once, under the last message, at that message's stage", () => {
        render(list([message("m1", "read", 0), message("m2", "delivered", 5), message("m3", "delivered", 10)]), {
            wrapper: MessagesWrapper
        });
        expect(ticks()).toEqual(["Delivered message-m3"]);
    });

    it("moves to a message appended to the block, and follows its stage live", () => {
        const { rerender } = render(list([message("m1", "read", 0), message("m2", "read", 5)]), {
            wrapper: MessagesWrapper
        });
        expect(ticks()).toEqual(["Read message-m2"]);

        rerender(list([message("m1", "read", 0), message("m2", "read", 5), message("m3", "sent", 10)]));
        expect(ticks()).toEqual(["Sent message-m3"]);

        rerender(list([message("m1", "read", 0), message("m2", "read", 5), message("m3", "read", 10)]));
        expect(ticks()).toEqual(["Read message-m3"]);
    });

    it("starts again after a gap long enough to break the block", () => {
        render(list([message("m1", "read", 0), message("m2", "read", 5), message("m3", "delivered", 10 * MINUTE)]), {
            wrapper: MessagesWrapper
        });
        expect(ticks()).toEqual(["Read message-m2", "Delivered message-m3"]);
    });

    it("starts again after somebody else speaks", () => {
        render(
            list([
                message("m1", "read", 0),
                message("m2", "read", 5),
                message("b1", null, 10, "bob"),
                message("m3", "delivered", 15)
            ]),
            { wrapper: MessagesWrapper }
        );
        expect(ticks()).toEqual(["Read message-m2", "Delivered message-m3"]);
    });

    it("stays on the last message that has a place for it, when a notice ends the block", () => {
        const notice = { ...message("n1", null, 10), kind: "system" } as ChatMessageView;
        render(list([message("m1", "delivered", 0), message("m2", "read", 5), notice]), {
            wrapper: MessagesWrapper
        });
        expect(ticks()).toEqual(["Read message-m2"]);
    });

    it("leaves a message still waiting to send its clock, wherever it is in the block", () => {
        render(list([message("m1", "read", 0), message("outbox:k1", null, 5), message("m3", "delivered", 10)]), {
            wrapper: MessagesWrapper
        });
        expect(ticks()).toEqual(["Delivered message-m3"]);
        expect(screen.getByRole("img", { name: "Waiting to send" }).closest("li")?.id).toBe("message-outbox:k1");
    });

    it("leaves a message that failed its retry, wherever it is in the block", () => {
        const failed: Outgoing = {
            id: "o1",
            scope: "c1",
            body: "message o1",
            files: [],
            kept: [],
            hidden: [],
            phase: "failed"
        };
        render(
            list([message("m1", "read", 0), message("outgoing:o1", null, 5), message("m3", "delivered", 10)], [failed]),
            { wrapper: MessagesWrapper }
        );
        expect(ticks()).toEqual(["Delivered message-m3"]);
        expect(screen.getByRole("alert").closest("li")?.id).toBe("message-outgoing:o1");
        expect(screen.getByRole("button", { name: /^Try sending/ })).toBeTruthy();
    });
});
