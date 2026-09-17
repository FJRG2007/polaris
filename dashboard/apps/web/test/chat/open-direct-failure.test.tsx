// @vitest-environment jsdom

/**
 * A conversation that cannot be opened says why, and on a phone - where it
 * fills the screen - it also offers the way back to the list.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined }) }));
vi.mock("@/app/(app)/chat/actions", () => ({
    openDirectAction: async () => ({ error: "You cannot message this person." })
}));

const { OpenDirect } = await import("@/app/(app)/chat/with/[userId]/open-direct");

afterEach(cleanup);

describe("opening a conversation that is refused", () => {
    it("shows the reason and a way back to the conversations", async () => {
        render(<OpenDirect userId="user-1" />);
        expect(await screen.findByText("You cannot message this person.")).toBeTruthy();
        const back = screen.getByRole("link", { name: "Back to conversations" });
        expect(back.getAttribute("href")).toBe("/chat");
    });
});
