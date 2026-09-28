/**
 * Where a linked player signs in from is shown to the people running a game
 * server only while an administrator lets it be. Administrators see it either
 * way, and what the server enforces never goes through the masking.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ shared: null as string | null, isAdmin: false, signedIn: true }));

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => state.shared,
    setSetting: async () => undefined
}));
vi.mock("@/lib/session", () => ({
    requireUser: async () => {
        if (!state.signedIn) throw new Error("NEXT_REDIRECT");
        return { id: "viewer", isAdmin: state.isAdmin };
    }
}));

const { forViewer, HIDDEN_SIGN_IN_ADDRESS } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/player-access"
);

type View = Parameters<typeof forViewer>[0];

const view = {
    rules: [
        { id: "1", username: "ada", address: "203.0.113.7", note: null, createdAt: "", source: "session" },
        { id: "2", username: "bob", address: "198.51.100.4", note: null, createdAt: "", source: "manual" }
    ],
    refusals: [],
    links: [],
    bindAddresses: true,
    addressesAvailable: true,
    edition: "java"
} as unknown as View;

describe("sign-in addresses on the player list", () => {
    beforeEach(() => {
        state.shared = null;
        state.isAdmin = false;
        state.signedIn = true;
    });

    it("shows them while the instance has never been told otherwise", async () => {
        expect((await forViewer(view)).rules.map((rule) => rule.address)).toEqual(["203.0.113.7", "198.51.100.4"]);
    });

    it("hides the ones copied from a sign-in once an administrator turns sharing off", async () => {
        state.shared = "false";
        const shown = await forViewer(view);
        expect(shown.rules.map((rule) => rule.address)).toEqual([HIDDEN_SIGN_IN_ADDRESS, "198.51.100.4"]);
        expect(view.rules[0]!.address).toBe("203.0.113.7");
    });

    it("still shows them to an administrator", async () => {
        state.shared = "false";
        state.isAdmin = true;
        expect((await forViewer(view)).rules[0]!.address).toBe("203.0.113.7");
    });

    it("shows nothing to a caller it cannot identify", async () => {
        state.signedIn = false;
        expect((await forViewer(view)).rules[0]!.address).toBe(HIDDEN_SIGN_IN_ADDRESS);
    });
});
