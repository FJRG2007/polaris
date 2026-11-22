// @vitest-environment jsdom

/**
 * Threads in direct messages and groups, as the message actions offer them.
 *
 * The list is handed `mayStartThread` for its conversation, the same decision
 * the send path makes: with the administrator's switch off, "Reply in a thread"
 * is neither on the hover bar nor in the menu of a direct message or group,
 * while a thread that already has replies stays one press away. A channel in a
 * space is not asked.
 */

import { ToastProvider } from "@polaris/ui";
import { MessagesWrapper } from "../../setup/i18n";
import type { ChatMessageView } from "@/lib/chat/messages";
import { mayStartThread } from "@/lib/chat/thread-rules";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/app/(app)/chat/actions", () => ({
    setReminderAction: async (input: { dueAt: string }) => ({ dueAt: input.dueAt }),
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
    useChat: () => ({
        blocked: new Set<string>(),
        friends: new Set<string>(),
        refresh: () => undefined,
        channels: [],
        spaces: []
    })
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));

const { MessageList } = await import("@/app/(app)/chat/message-list");

beforeAll(() => {
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
    vi.stubGlobal(
        "matchMedia",
        (query: string) =>
            ({
                matches: false,
                media: query,
                addEventListener: () => undefined,
                removeEventListener: () => undefined
            }) as unknown as MediaQueryList
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function message(replyCount: number): ChatMessageView {
    return {
        id: "0190a1b2-0000-7000-8000-000000000001",
        channelId: "c1",
        authorId: "grace",
        authorName: "grace",
        body: "See you at noon",
        kind: "text",
        parentId: null,
        replyCount,
        lastReplyAt: replyCount ? new Date(1_700_000_000_000).toISOString() : null,
        edited: false,
        deleted: false,
        forwardable: true,
        starred: false,
        blocked: false,
        mentionsYou: false,
        references: [],
        reactions: [],
        attachments: [],
        poll: null,
        quote: null,
        link: null,
        preview: null,
        previewPending: false,
        receipt: null,
        createdAt: new Date(1_700_000_000_000).toISOString()
    } as unknown as ChatMessageView;
}

function list(
    channel: { kind: string; spaceId: string | null },
    switchOn: boolean,
    shown: ChatMessageView,
    onOpenThread: (message: ChatMessageView) => void = () => undefined
) {
    return render(
        <ToastProvider>
            <MessageList
                messages={[shown]}
                viewerId="ada"
                canPost
                canModerate={false}
                onReact={() => undefined}
                onStar={() => undefined}
                onDelete={() => undefined}
                onReply={() => undefined}
                onOpenThread={onOpenThread}
                threadAllowed={(row) => mayStartThread(channel, switchOn, row.replyCount)}
            />
        </ToastProvider>,
        { wrapper: MessagesWrapper }
    );
}

const hoverButton = () => screen.queryByRole("button", { name: "Reply in a thread" });

function menuItem(): HTMLElement | null {
    fireEvent.contextMenu(screen.getByText("See you at noon"));
    return screen.queryByRole("menuitem", { name: /Reply in a thread/ });
}

describe("with the switch off", () => {
    for (const kind of ["dm", "group"]) {
        it(`offers no new thread in a ${kind}, on the bar or in the menu`, () => {
            list({ kind, spaceId: null }, false, message(0));
            expect(hoverButton()).toBeNull();
            expect(menuItem()).toBeNull();
        });
    }

    it("keeps an existing thread in a direct message readable", () => {
        const opened = vi.fn();
        list({ kind: "dm", spaceId: null }, false, message(3), opened);
        const replies = screen.getByRole("button", { name: /3 replies/i });
        fireEvent.click(replies);
        expect(opened).toHaveBeenCalledTimes(1);
    });

    it("leaves a space's channels alone", () => {
        list({ kind: "text", spaceId: "s1" }, false, message(0));
        expect(hoverButton()).not.toBeNull();
        expect(menuItem()).not.toBeNull();
    });
});

describe("with the switch on", () => {
    for (const kind of ["dm", "group"]) {
        it(`offers a thread in a ${kind}`, () => {
            list({ kind, spaceId: null }, true, message(0));
            expect(hoverButton()).not.toBeNull();
            expect(menuItem()).not.toBeNull();
        });
    }
});
