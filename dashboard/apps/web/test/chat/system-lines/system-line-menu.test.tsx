// @vitest-environment jsdom

/**
 * What the message menu offers on a line Polaris wrote.
 *
 * Reactions and Reply, as on any message, and nothing that needs an author:
 * there is nobody to answer privately or report, and nothing of anybody's to
 * rewrite or take down - so those are absent rather than offered and refused,
 * even to a moderator.
 */

import { ToastProvider } from "@polaris/ui";
import { MessagesWrapper } from "../../setup/i18n";
import userEvent from "@testing-library/user-event";
import type { ChatMessageView } from "@/lib/chat/messages";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MessageMenu, type MessageActions } from "@/app/(app)/chat/message-menu";

vi.mock("@/app/(app)/chat/actions", () => ({ setReminderAction: async () => ({}) }));

beforeAll(() => {
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.scrollIntoView ??= () => {};
});

afterEach(cleanup);

const LINE = {
    id: "0190a1b2-0000-7000-8000-000000000001",
    channelId: "c1",
    authorId: null,
    authorName: null,
    body: "The call ended after 1 hour 48 minutes",
    kind: "system",
    deleted: false,
    forwardable: true,
    starred: false,
    reactions: [],
    attachments: []
} as unknown as ChatMessageView;

function menu(message: ChatMessageView, extra: Partial<MessageActions> = {}) {
    return render(
        <ToastProvider>
            <MessageMenu
                actions={{
                    message,
                    mine: false,
                    canPost: true,
                    canModerate: true,
                    onReact: () => {},
                    quick: ["👍", "🎉"],
                    onReply: () => {},
                    onReplyPrivately: () => {},
                    onForward: () => {},
                    onOpenThread: () => {},
                    onEdit: () => {},
                    onStar: () => {},
                    onDelete: () => {},
                    onReport: () => {},
                    onExplain: () => {},
                    ...extra
                }}
            >
                <p data-testid="row">{message.body}</p>
            </MessageMenu>
        </ToastProvider>,
        { wrapper: MessagesWrapper }
    );
}

const open = () =>
    userEvent.pointer({ keys: "[MouseRight]", target: screen.getByTestId("row") });

describe("the menu on a line Polaris wrote", () => {
    it("reacts and replies through the same actions as any message", async () => {
        const onReact = vi.fn();
        const onReply = vi.fn();
        menu(LINE, { onReact, onReply });
        await open();
        const faces = await screen.findAllByLabelText(/^React with/);
        expect(faces).toHaveLength(2);
        await userEvent.click(faces[1]!);
        expect(onReact).toHaveBeenCalledWith(LINE.id, "🎉");

        await open();
        await userEvent.click(await screen.findByText("Reply"));
        expect(onReply).toHaveBeenCalledWith(LINE);
    });

    it("offers nothing that needs an author, even to a moderator", async () => {
        menu(LINE);
        await open();
        await screen.findByText("Reply");
        for (const absent of [
            "Edit",
            "Delete",
            "Reply privately",
            "Forward",
            "Reply in a thread",
            "Report this message"
        ]) {
            expect(screen.queryByText(absent)).toBeNull();
        }
        expect(screen.getByText("Copy text")).toBeTruthy();
    });

    it("has no reactions or reply where the reader may not post", async () => {
        menu(LINE, { canPost: false });
        await open();
        await screen.findByText("Copy text");
        expect(screen.queryAllByLabelText(/^React with/)).toHaveLength(0);
        expect(screen.queryByText("Reply")).toBeNull();
    });

    it("still offers a person's message everything it did", async () => {
        menu({ ...LINE, kind: "text", authorId: "grace" } as ChatMessageView, { mine: false });
        await open();
        await screen.findByText("Reply");
        expect(screen.getByText("Delete")).toBeTruthy();
        expect(screen.getByText("Forward")).toBeTruthy();
        expect(screen.getByText("Report this message")).toBeTruthy();
    });
});
