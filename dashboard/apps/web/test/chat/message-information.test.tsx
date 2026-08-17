// @vitest-environment jsdom

/**
 * The panel that spells out how far one message got.
 *
 * There is a real answer that carries no moments at all: the other person turned
 * the ticks off between the conversation being drawn and this being opened, or the
 * message has since gone. Reading that as "still asking" left a spinner nothing
 * would ever take down, which is the one state a panel must not have.
 */

import { ChatMessageView } from "@/lib/chat/messages";
import { cleanup, render, screen } from "@testing-library/react";
import { MessageInfoDialog } from "@/app/(app)/chat/message-info-dialog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let answer: { delivery?: unknown; error?: string } = {};

vi.mock("@/app/(app)/chat/actions", () => ({
    messageDeliveryAction: async () => answer
}));

const message = { id: "m2" } as ChatMessageView;

beforeEach(() => {
    answer = {};
});

afterEach(cleanup);

describe("message information", () => {
    it("says there is nothing to show rather than spinning forever", async () => {
        // What the action answers when the ticks are no longer this reader's to
        // see: no delivery, and no error either.
        render(<MessageInfoDialog message={message} onOpenChange={() => undefined} />);
        expect(await screen.findByText(/nothing to show/i)).toBeTruthy();
        expect(screen.queryByText("Looking")).toBeNull();
    });

    it("draws the three moments when there are three moments", async () => {
        answer = {
            delivery: {
                sentAt: "2026-08-17T10:00:00.000Z",
                deliveredAt: "2026-08-17T10:05:00.000Z",
                readAt: "2026-08-17T10:06:00.000Z",
                state: "read"
            }
        };
        render(<MessageInfoDialog message={message} onOpenChange={() => undefined} />);
        expect(await screen.findByText("Read")).toBeTruthy();
        expect(screen.queryByText(/nothing to show/i)).toBeNull();
    });
});
