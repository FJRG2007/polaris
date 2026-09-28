// @vitest-environment jsdom

/**
 * The page for "the conversation with this person".
 *
 * What is pinned: a conversation that already exists is gone to from the server,
 * in one navigation, without the browser having to ask for it first; one that
 * does not exist yet is left to the browser to open, because opening can create
 * it and a page render must never write; and a refusal found on the server is
 * shown as it is, without the same question being asked a second time.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class ChatAccessError extends Error {}

const GRACE = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

let existing: () => Promise<string | null> = async () => null;
let redirected: string | null = null;
let opened = 0;

vi.mock("next/navigation", () => ({
    redirect: (to: string) => {
        redirected = to;
        throw new Error("NEXT_REDIRECT");
    },
    useRouter: () => ({ replace: () => undefined })
}));
vi.mock("@/lib/session", () => ({
    requirePermission: async () => ({ id: "ada", name: "Ada" })
}));
vi.mock("@/lib/chat/chat-service", () => ({
    ChatAccessError,
    existingDirect: () => existing()
}));
vi.mock("@/app/(app)/chat/actions", () => ({
    openDirectAction: async () => {
        opened += 1;
        return { error: "opened from the browser" };
    }
}));

const { default: ChatWithPage } = await import("@/app/(app)/chat/with/[userId]/page");

const page = (userId: string) => ChatWithPage({ params: Promise.resolve({ userId }) });

beforeEach(() => {
    existing = async () => null;
    redirected = null;
    opened = 0;
});

afterEach(cleanup);

describe("the conversation with somebody", () => {
    it("goes straight to one that already exists", async () => {
        existing = async () => "dm-1";
        await expect(page(GRACE)).rejects.toThrow("NEXT_REDIRECT");
        expect(redirected).toBe("/chat/c/dm-1");
    });

    it("leaves one that does not exist yet to the browser to open", async () => {
        render(await page(GRACE));
        expect(await screen.findByText("opened from the browser")).toBeTruthy();
        expect(opened).toBeGreaterThan(0);
        expect(redirected).toBeNull();
    });

    it("says why it is refused without asking again", async () => {
        existing = async () => {
            throw new ChatAccessError("You cannot start that conversation");
        };
        render(await page(GRACE));
        expect(await screen.findByText("You cannot start that conversation")).toBeTruthy();
        expect(screen.getByRole("link", { name: "Back to conversations" })).toBeTruthy();
        expect(opened).toBe(0);
    });

    it("leaves an address that is not a person to the browser to explain", async () => {
        existing = async () => {
            throw new Error("reached the database with it");
        };
        render(await page("not-a-person"));
        expect(await screen.findByText("opened from the browser")).toBeTruthy();
    });
});
