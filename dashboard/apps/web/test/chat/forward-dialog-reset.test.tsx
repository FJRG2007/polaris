// @vitest-environment jsdom

/**
 * Nothing carried from the last time the forward dialog was open.
 *
 * The dialog is never unmounted when it closes - `message` is what opens it,
 * and the component stays there holding whatever was typed or chosen. Two bugs
 * shipped from that: what somebody wrote about one message was still in the box
 * when the dialog reopened on another, and a forward cancelled with
 * conversations chosen offered to send the next message to those same ones.
 *
 * The second is the one worth keeping a test on forever. A stale note is
 * embarrassing; a stale set of recipients is a message sent to people nobody
 * meant to send it to, one press away.
 */

import userEvent from "@testing-library/user-event";
import type { ChatMessageView } from "@/lib/chat/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForwardDialog } from "@/app/(app)/chat/forward-dialog";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/app/(app)/chat/actions", () => ({
    forwardAction: async () => ({ id: "sent" })
}));

vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({
        channels: [
            {
                id: "c1",
                spaceId: null,
                categoryId: null,
                kind: "dm",
                name: "Grace",
                archived: false,
                others: [{ id: "grace", name: "Grace" }]
            },
            {
                id: "c2",
                spaceId: null,
                categoryId: null,
                kind: "dm",
                name: "Ada",
                archived: false,
                others: [{ id: "ada", name: "Ada" }]
            }
        ],
        spaces: []
    })
}));

function message(id: string): ChatMessageView {
    return {
        id,
        channelId: "origin",
        authorId: "someone",
        authorName: "Someone",
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
        forwardable: true,
        link: null,
        preview: null,
        previewPending: false,
        receipt: null,
        createdAt: new Date(1_700_000_000_000).toISOString()
    } as unknown as ChatMessageView;
}

afterEach(cleanup);

describe("the forward dialog reopened on a different message", () => {
    it("does not keep the note typed about the last message", async () => {
        const user = userEvent.setup();
        const { rerender } = render(
            <ForwardDialog
                message={message("m1")}
                onOpenChange={() => undefined}
                onSent={() => undefined}
            />
        );

        const field = screen.getByLabelText("Say something about it") as HTMLInputElement;
        await user.type(field, "look at this one");
        expect(field.value).toBe("look at this one");

        // Closed, then reopened on a different message.
        rerender(
            <ForwardDialog
                message={null}
                onOpenChange={() => undefined}
                onSent={() => undefined}
            />
        );
        rerender(
            <ForwardDialog
                message={message("m2")}
                onOpenChange={() => undefined}
                onSent={() => undefined}
            />
        );

        expect((screen.getByLabelText("Say something about it") as HTMLInputElement).value).toBe(
            ""
        );
    });

    it("does not keep a forward's chosen conversations after it reopens", async () => {
        const user = userEvent.setup();
        const { rerender } = render(
            <ForwardDialog
                message={message("m1")}
                onOpenChange={() => undefined}
                onSent={() => undefined}
            />
        );

        await user.click(screen.getByRole("button", { name: "GRGrace" }));
        expect(
            (screen.getByRole("button", { name: "Forward" }) as HTMLButtonElement).disabled
        ).toBe(false);

        // Cancelled, then reopened on a different message entirely.
        rerender(
            <ForwardDialog message={null} onOpenChange={() => undefined} onSent={() => undefined} />
        );
        rerender(
            <ForwardDialog
                message={message("m2")}
                onOpenChange={() => undefined}
                onSent={() => undefined}
            />
        );

        // With nothing chosen again, sending is refused.
        expect(
            (screen.getByRole("button", { name: "Forward" }) as HTMLButtonElement).disabled
        ).toBe(true);
    });
});
