/**
 * The nonce is presented only for the server the app shows, only from an
 * allowed extension, and the server's answer becomes a reason the extension knows.
 */

import { describe, expect, it, vi } from "vitest";
import type { PairMessage } from "@/main/native-host/protocol";
import { presentNonce, type PairingDeps } from "@/main/native-host/pairing";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const message: PairMessage = {
    type: "pair",
    server: "https://polaris.example",
    nonce: "AbCdEfGhIjKlMnOpQrStUvWxYz012345",
    caller: { browser: "chromium", id: ID }
};

function deps(status: number | null, overrides: Partial<PairingDeps> = {}): PairingDeps & { claim: ReturnType<typeof vi.fn>; } {
    return {
        servers: () => ["https://polaris.example"],
        allowedIds: () => new Set([ID]),
        claim: vi.fn(async () => status),
        ...overrides
    } as PairingDeps & { claim: ReturnType<typeof vi.fn>; };
}

describe("presenting the extension's nonce", () => {
    it("presents it to the server the window shows", async () => {
        const d = deps(200);
        expect(await presentNonce(message, d)).toEqual({ ok: true });
        expect(d.claim).toHaveBeenCalledWith("https://polaris.example", message.nonce);
    });

    it("never presents a nonce for another server", async () => {
        const d = deps(200, { servers: () => ["https://other.example"] });
        expect(await presentNonce(message, d)).toEqual({ ok: false, reason: "other-server" });
        expect(d.claim).not.toHaveBeenCalled();
    });

    it("never presents one from an extension the manifests do not allow", async () => {
        const d = deps(200, { allowedIds: () => new Set() });
        expect(await presentNonce(message, d)).toEqual({ ok: false, reason: "refused" });
        const firefox = deps(200);
        const fromOther = await presentNonce({ ...message, caller: { browser: "firefox", id: "other@example" } }, firefox);
        expect(fromOther).toEqual({ ok: false, reason: "refused" });
        expect(firefox.claim).not.toHaveBeenCalled();
    });

    it("accepts the Firefox add-on by its fixed id", async () => {
        const reply = await presentNonce({ ...message, caller: { browser: "firefox", id: "vault@polaris.local" } }, deps(200));
        expect(reply).toEqual({ ok: true });
    });

    it.each([
        [401, "signed-out"],
        [400, "bad-request"],
        [403, "refused"],
        [409, "refused"],
        [429, "refused"],
        [null, "unreachable"]
    ] as const)("answers HTTP %s as %s", async (status, reason) => {
        expect(await presentNonce(message, deps(status))).toEqual({ ok: false, reason });
    });
});
