// @vitest-environment jsdom

/**
 * The screen that decides on a client asking to be let into this vault.
 *
 * What is pinned here is the failure nobody would report: the public half is
 * whatever the asking client sent, sealing to it happens in this browser because
 * no other party can do it, and a key that is not a key makes that step throw. Left
 * to escape, the rejection takes both buttons with it - they stay disabled reading
 * "Working", with nothing on screen saying why and nothing to do but reload - and
 * the request that planted the key was unauthenticated, so any client could leave
 * that waiting for whoever opened the page.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const answerAuthorizationAction = vi.fn(async () => ({}) as { ok?: true; error?: string });

/** The service behind the actions reaches Prisma; none of it runs here. */
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("server-only", () => ({}));

vi.mock("next/navigation", () => ({
    useSearchParams: () => new URLSearchParams("")
}));

vi.mock("@/app/(app)/vault/authorize/actions", () => ({
    describeAuthorizationAction: vi.fn(async () => ({
        pending: {
            userCode: "BCDFGHJK",
            device: "Chrome extension",
            requestIp: "203.0.113.7",
            host: "polaris.example",
            // Not a key. This is the point of the test.
            publicKey: "!!!! not base64 !!!!",
            requestedAt: "2026-09-14T10:00:00.000Z",
            expiresAt: "2026-09-14T10:05:00.000Z"
        }
    })),
    answerAuthorizationAction: (...args: unknown[]) => answerAuthorizationAction(...args)
}));

vi.mock("@/lib/vault/crypto", () => ({
    symmetricKeyBytes: () => new Uint8Array(64),
    // What WebCrypto does with a public half it cannot import.
    encryptRsa: async () => {
        throw new Error("not a public key");
    }
}));

vi.mock("@/app/(app)/vault/vault-session", () => ({
    useVaultSession: () => ({ key: {} as never })
}));

const { AuthorizeView } = await import("@/app/(app)/vault/authorize/authorize-view");

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("the approval screen", () => {
    it("refuses a request whose key cannot be sealed to, and stays usable", async () => {
        render(<AuthorizeView />);
        fireEvent.change(screen.getByPlaceholderText("XXXX-XXXX"), {
            target: { value: "BCDFGHJK" }
        });
        fireEvent.click(screen.getByRole("button", { name: "Find it" }));

        fireEvent.click(await screen.findByRole("button", { name: "Let it in" }));

        const said = await screen.findByRole("alert");
        expect(said.textContent).toContain("usable key");
        // Nothing was approved: there is no key to hand over, and a row marked
        // approved with nothing sealed into it is worse than a refusal.
        expect(answerAuthorizationAction).not.toHaveBeenCalled();
        // And the decision is still there to be made, rather than two buttons stuck
        // on "Working" - which is what an unhandled rejection here looks like.
        expect(screen.getByRole("button", { name: "Let it in" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Turn it away" })).toBeTruthy();
    });
});
