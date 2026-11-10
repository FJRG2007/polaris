// @vitest-environment jsdom
/**
 * An invitation somebody sent can be withdrawn from the card they see in the
 * conversation, after a confirmation that says who loses it. Somebody who did
 * not make it, and has no say over the space, is not offered the button.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessagesWrapper } from "../setup/i18n";
import type { ChatInviteCard } from "@/lib/chat/invite-cards";

const state = vi.hoisted(() => ({ revoked: [] as string[], answer: {} as { error?: string } }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/(app)/chat/actions", () => ({
    acceptInviteAction: vi.fn(),
    revokeInviteCardAction: async (code: string) => {
        state.revoked.push(code);
        return state.answer;
    }
}));
vi.mock("@/components/chat-avatar", () => ({ ChatAvatar: () => null }));

const { InviteCard } = await import("@/app/(app)/chat/invite-card");

const CARD: ChatInviteCard = {
    code: "abcDEF12",
    spaceId: "space-1",
    spaceName: "Builders",
    spaceColor: "#336699",
    channelId: null,
    usable: true,
    member: true,
    members: 4,
    online: 1,
    canRevoke: true
};

afterEach(() => {
    cleanup();
    state.revoked = [];
    state.answer = {};
});

describe("revoking a sent invite", () => {
    it("asks first, then withdraws it and shows it as invalid", async () => {
        render(<InviteCard card={CARD} mine />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
        expect(await screen.findByText("Revoke this invite?")).toBeTruthy();
        const confirm = screen.getAllByRole("button", { name: "Revoke" }).at(-1)!;
        fireEvent.click(confirm);
        await waitFor(() => expect(state.revoked).toEqual(["abcDEF12"]));
        expect(await screen.findByText("Invalid invite")).toBeTruthy();
    });

    it("puts the card back when the server refuses", async () => {
        state.answer = { error: "That invitation is gone" };
        render(<InviteCard card={CARD} mine />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
        await screen.findByText("Revoke this invite?");
        fireEvent.click(screen.getAllByRole("button", { name: "Revoke" }).at(-1)!);
        expect(await screen.findByRole("alert")).toBeTruthy();
        expect(screen.getByText("Builders")).toBeTruthy();
    });

    it("is not offered to the person invited, or to somebody with no say", () => {
        render(<InviteCard card={CARD} mine={false} />, { wrapper: MessagesWrapper });
        expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
        cleanup();
        render(<InviteCard card={{ ...CARD, canRevoke: false }} mine />, { wrapper: MessagesWrapper });
        expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
    });
});
