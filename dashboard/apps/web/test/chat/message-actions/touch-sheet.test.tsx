// @vitest-environment jsdom

/**
 * A message's actions on a touch screen.
 *
 * - A long press opens them in a sheet from the bottom; a press that moves (a
 *   scroll, a swipe) or lifts early opens nothing.
 * - The sheet offers exactly what the right-click menu offers for the same
 *   message and reader, because both are drawn from one list, with the
 *   destructive actions last.
 * - Submenus open inside the sheet, with a way back.
 * - The hover bar is not drawn on a message row at all.
 */

import { ToastProvider } from "@polaris/ui";
import { MessagesWrapper } from "../../setup/i18n";
import userEvent from "@testing-library/user-event";
import type { ChatMessageView } from "@/lib/chat/messages";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

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

const { MessageMenu } = await import("@/app/(app)/chat/message-menu");
const { MessageList } = await import("@/app/(app)/chat/message-list");
const { HOLD_MS } = await import("@/app/(app)/chat/long-press");
type MessageActions = import("@/app/(app)/chat/message-menu").MessageActions;

/** Whether the screen in this test is worked by a finger. */
let coarse = false;

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
                matches: query.includes("pointer: coarse") ? coarse : false,
                media: query,
                addEventListener: () => undefined,
                removeEventListener: () => undefined
            }) as unknown as MediaQueryList
    );
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    coarse = false;
});

const MESSAGE = {
    id: "0190a1b2-0000-7000-8000-000000000001",
    channelId: "c1",
    authorId: "grace",
    authorName: "grace",
    body: "See you at noon",
    kind: "text",
    parentId: null,
    replyCount: 0,
    lastReplyAt: null,
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

function menu(extra: Partial<MessageActions> = {}) {
    return render(
        <ToastProvider>
            <MessageMenu
                actions={{
                    message: MESSAGE,
                    mine: false,
                    canPost: true,
                    canModerate: true,
                    onReply: () => {},
                    onForward: () => {},
                    onOpenThread: () => {},
                    onMarkUnread: () => {},
                    onPin: () => {},
                    onStar: () => {},
                    onDelete: () => {},
                    onReport: () => {},
                    onExplain: () => {},
                    onReact: () => {},
                    quick: ["👍", "❤️", "😄"],
                    onAddReaction: () => {},
                    ...extra
                }}
            >
                <div data-testid="row">
                    <p data-testid="text">See you at noon</p>
                </div>
            </MessageMenu>
        </ToastProvider>,
        { wrapper: MessagesWrapper }
    );
}

/** A finger held on the text for `ms`, moving `move` pixels on the way. */
function hold(ms: number, move = 0) {
    const text = screen.getByTestId("text");
    fireEvent.pointerDown(text, {
        pointerType: "touch",
        isPrimary: true,
        clientX: 10,
        clientY: 10
    });
    if (move)
        fireEvent.pointerMove(text, { pointerType: "touch", clientX: 10, clientY: 10 + move });
    act(() => {
        vi.advanceTimersByTime(ms);
    });
}

/** The actions a surface offers, in order. */
const actionsIn = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLElement>("[data-action]")].map((line) => line.dataset.action);

describe("a long press on a touch screen", () => {
    it("opens the actions in a sheet, not the right-click menu", () => {
        coarse = true;
        vi.useFakeTimers();
        menu();
        hold(HOLD_MS + 10);
        const sheet = screen.getByRole("dialog");
        expect(within(sheet).getByText("Reply")).toBeTruthy();
        expect(screen.queryByRole("menu")).toBeNull();
        // The faces come from the same list the hover bar reacts with.
        expect(within(sheet).getAllByLabelText(/^React with/)).toHaveLength(3);
        expect(within(sheet).getByLabelText("Add reaction")).toBeTruthy();
    });

    it("opens nothing for a short tap or a press that starts a scroll", () => {
        coarse = true;
        vi.useFakeTimers();
        menu();
        hold(HOLD_MS / 2);
        fireEvent.pointerUp(screen.getByTestId("text"));
        act(() => {
            vi.advanceTimersByTime(HOLD_MS);
        });
        expect(screen.queryByRole("dialog")).toBeNull();
        hold(HOLD_MS + 10, 30);
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("refuses the browser's own long-press menu", () => {
        coarse = true;
        vi.useFakeTimers();
        menu();
        const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        act(() => {
            screen.getByTestId("text").dispatchEvent(event);
        });
        expect(event.defaultPrevented).toBe(true);
    });

    it("opens a submenu inside the sheet, with a way back", async () => {
        coarse = true;
        vi.useFakeTimers();
        menu();
        hold(HOLD_MS + 10);
        vi.useRealTimers();
        const sheet = screen.getByRole("dialog");
        await userEvent.click(within(sheet).getByText("Remind me"));
        expect(within(screen.getByRole("dialog")).getByText("Custom...")).toBeTruthy();
        expect(screen.getAllByRole("dialog")).toHaveLength(1);
        await userEvent.click(within(screen.getByRole("dialog")).getByText("Back"));
        expect(within(screen.getByRole("dialog")).getByText("Reply")).toBeTruthy();
    });
});

describe("one list for the menu and the sheet", () => {
    for (const mine of [false, true]) {
        it(`offers the same actions, destructive last, on ${mine ? "your own" : "someone else's"} message`, async () => {
            menu({ mine, onEdit: () => {} });
            await userEvent.pointer({ keys: "[MouseRight]", target: screen.getByTestId("text") });
            const desktop = actionsIn(await screen.findByRole("menu"));
            cleanup();

            coarse = true;
            vi.useFakeTimers();
            menu({ mine, onEdit: () => {} });
            hold(HOLD_MS + 10);
            const sheet = screen.getByRole("dialog");
            expect(actionsIn(sheet)).toEqual(desktop);
            expect(desktop).toContain(mine ? "edit" : "report");
            expect(desktop).toContain("delete");

            // The heavy ones last, in red.
            const lines = [...sheet.querySelectorAll<HTMLElement>("[data-action]")];
            const danger = lines.filter((line) => line.hasAttribute("data-danger"));
            expect(danger.map((line) => line.dataset.action)).toEqual(
                mine ? ["delete"] : ["delete", "report"]
            );
            expect(lines.slice(-danger.length)).toEqual(danger);
        });
    }
});

describe("the hover bar", () => {
    const list = () =>
        render(
            <MessageList
                messages={[MESSAGE as never]}
                viewerId="ada"
                canPost
                canModerate={false}
                onReact={() => undefined}
                onStar={() => undefined}
                onDelete={() => undefined}
                onReply={() => undefined}
            />,
            { wrapper: MessagesWrapper }
        );

    it("is there under a mouse", () => {
        list();
        expect(screen.queryByRole("button", { name: "Star this message" })).not.toBeNull();
    });

    it("is not drawn on a touch screen", () => {
        coarse = true;
        list();
        expect(screen.queryByRole("button", { name: "Star this message" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
    });
});
