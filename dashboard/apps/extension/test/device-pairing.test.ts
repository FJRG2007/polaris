/**
 * Pairing the extension's connection with Polaris Desktop through native
 * messaging: the nonce goes from the server to the desktop app, and anything
 * that is not there - the desktop, the endpoint on an old server - just leaves
 * things as they were, quietly.
 */

import { NATIVE_HOST_NAME } from "@polaris/core";
import { describe, expect, it, vi } from "vitest";
import { PAIRING_RETRY_MS, pairWithDesktop, pairingDue, rememberPairing, type PairingDeps } from "@/lib/device-pairing";

const ORIGIN = "https://polaris.example.test";
const NONCE = "n".repeat(43);
const CHROME_ID = "abcdefghijklmnopabcdefghijklmnop";

function deps(reply: Response | Error, native?: (host: string, message: unknown) => Promise<unknown>): PairingDeps & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
        calls,
        fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            calls.push(JSON.parse(String(init?.body)));
            if (reply instanceof Error) throw reply;
            return reply;
        }) as unknown as typeof fetch,
        sendNative: native ?? null,
        runtimeId: CHROME_ID
    };
}

const offer = () => Response.json({ paired: false, nonce: NONCE, expiresAt: "2026-11-23T10:02:00Z" });

describe("pairing with Polaris Desktop", () => {
    it("hands the nonce to the desktop's native host and reports it sent", async () => {
        const native = vi.fn(async () => ({ ok: true }));
        const given = deps(offer(), native);
        expect(await pairWithDesktop(ORIGIN, "token", given)).toBe("sent");
        expect(native).toHaveBeenCalledWith(NATIVE_HOST_NAME, { type: "pair", server: ORIGIN, nonce: NONCE });
        expect(given.calls[0]).toEqual({ runtimeId: CHROME_ID });
    });

    it("stops once the server says the connection is paired", async () => {
        const native = vi.fn();
        expect(await pairWithDesktop(ORIGIN, "token", deps(Response.json({ paired: true }), native))).toBe("paired");
        expect(native).not.toHaveBeenCalled();
    });

    it("leaves things alone on a server from before pairing", async () => {
        expect(await pairWithDesktop(ORIGIN, "token", deps(new Response("<html>", { status: 404 })))).toBe("unsupported");
        expect(await pairWithDesktop(ORIGIN, "token", deps(Response.json({ something: "else" })))).toBe("unsupported");
    });

    it("reads a missing or unregistered desktop app as no desktop, without throwing", async () => {
        expect(await pairWithDesktop(ORIGIN, "token", deps(offer()))).toBe("no-desktop");
        const missing = async () => {
            throw new Error("Specified native messaging host not found.");
        };
        expect(await pairWithDesktop(ORIGIN, "token", deps(offer(), missing))).toBe("no-desktop");
    });

    it("reports a desktop refusal and an unreachable server as outcomes, not errors", async () => {
        expect(await pairWithDesktop(ORIGIN, "token", deps(offer(), async () => ({ ok: false, reason: "signed-out" })))).toBe("refused");
        expect(await pairWithDesktop(ORIGIN, "token", deps(new TypeError("offline")))).toBe("failed");
        expect(await pairWithDesktop(ORIGIN, "token", deps(new Response("", { status: 401 })))).toBe("signed-out");
    });

    it("sends no browser id that is not a Chromium one", async () => {
        const given = { ...deps(Response.json({ paired: true })), runtimeId: "vault@polaris.local" };
        const calls: unknown[] = [];
        given.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            calls.push(JSON.parse(String(init?.body)));
            return Response.json({ paired: true });
        }) as typeof fetch;
        await pairWithDesktop(ORIGIN, "token", given);
        expect(calls[0]).toEqual({ runtimeId: null });
    });
});

describe("when to try again", () => {
    const NOW = 1_000_000_000_000;

    it("tries a new connection, never a paired one, and an unpaired one after a while", () => {
        expect(pairingDue(null, "a", NOW)).toBe(true);
        expect(pairingDue(rememberPairing("a", "paired", NOW), "a", NOW + PAIRING_RETRY_MS * 10)).toBe(false);
        expect(pairingDue(rememberPairing("a", "no-desktop", NOW), "a", NOW + 1000)).toBe(false);
        expect(pairingDue(rememberPairing("a", "no-desktop", NOW), "a", NOW + PAIRING_RETRY_MS)).toBe(true);
        expect(pairingDue(rememberPairing("a", "paired", NOW), "b", NOW)).toBe(true);
    });

    it("checks again right away after the desktop took the nonce", () => {
        expect(pairingDue(rememberPairing("a", "sent", NOW), "a", NOW)).toBe(true);
    });
});
