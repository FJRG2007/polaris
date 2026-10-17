// @vitest-environment jsdom

/**
 * The invite dialog sends to a friend without any step before it.
 *
 * The regression: sending to somebody from the dialog answered "Make a link
 * first." unless a link had been made by hand in the same dialog, because the
 * send needed an existing usable link and opening the dialog made none. Now
 * opening it makes (or reuses) the link, the friends list sends it at once, and
 * the row turns into "Sent" without the dialog closing.
 */

import { MessagesWrapper } from "../setup/i18n";
import { InviteDialog } from "@/app/(app)/chat/invite-dialog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const sent: unknown[] = [];
let sendAnswer: { channelId?: string; error?: string } = { channelId: "dm-1" };

vi.mock("@/app/(app)/chat/actions", () => ({
    inviteLinkAction: async () => ({
        invite: {
            id: "inv-1",
            code: "AbCdEf1234",
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
            maxUses: null,
            uses: 0,
            usable: true,
            createdAt: new Date().toISOString(),
            channelId: "c1",
            createdBy: "Ada"
        }
    }),
    inviteCandidatesAction: async () => ({
        people: [
            { id: "grace", name: "Grace Hopper", username: "grace", member: false },
            { id: "alan", name: "Alan Turing", username: "alan", member: true }
        ]
    }),
    inviteToDirectAction: async (input: unknown) => {
        sent.push(input);
        return sendAnswer;
    },
    createInviteAction: async () => ({})
}));

vi.mock("@/app/(app)/chat/chat-context", () => ({
    useChat: () => ({ channels: [{ id: "c1", name: "general" }] })
}));

vi.mock("@/components/app-url", () => ({ useAppUrl: () => "https://polaris.example" }));
vi.mock("@/components/avatar", () => ({ Avatar: () => null }));

const space = {
    id: "0193b0f0-0000-7000-8000-0000000000aa",
    name: "Dymo",
    access: "member",
    visibility: "internal"
} as never;

beforeEach(() => {
    sent.length = 0;
    sendAnswer = { channelId: "dm-1" };
});

afterEach(() => cleanup());

describe("the invite dialog", () => {
    it("sends to a friend straight away and marks the row as sent", async () => {
        render(<InviteDialog space={space} channelId="c1" onOpenChange={() => undefined} />, {
            wrapper: MessagesWrapper
        });

        expect(await screen.findByText("Invite friends to Dymo")).toBeTruthy();
        // The link is there on open, with no button to make it.
        await waitFor(() =>
            expect(
                (
                    screen.getByDisplayValue(
                        "https://polaris.example/chat/i/AbCdEf1234"
                    ) as HTMLInputElement
                ).value
            ).toBe("https://polaris.example/chat/i/AbCdEf1234")
        );
        expect(screen.getByText(/expires in 7 days/)).toBeTruthy();
        // Somebody already in it is shown as such, with nothing to press.
        expect(screen.getByText("Member")).toBeTruthy();

        const invite = await screen.findByRole("button", { name: "Invite" });
        await waitFor(() => expect((invite as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(invite);

        expect(await screen.findByRole("button", { name: "Sent" })).toBeTruthy();
        expect(sent).toEqual([{ code: "AbCdEf1234", userId: "grace" }]);
        expect(screen.queryByText("Make a link first.")).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("puts the row back and says why when the send is refused", async () => {
        sendAnswer = { error: "They do not take messages from you" };
        render(<InviteDialog space={space} channelId="c1" onOpenChange={() => undefined} />, {
            wrapper: MessagesWrapper
        });
        const invite = await screen.findByRole("button", { name: "Invite" });
        await waitFor(() => expect((invite as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(invite);

        expect((await screen.findByRole("alert")).textContent).toContain(
            "They do not take messages from you"
        );
        expect(screen.getByRole("button", { name: "Invite" })).toBeTruthy();
    });
});
