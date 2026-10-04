/**
 * A vault session through a refresh that fails, in the real worker.
 *
 * Offline for a minute used to be signed out: every refresh failure dropped
 * the stored session. Now only the server refusing the token does; a refresh
 * that gets no answer keeps the session, the popup says Polaris cannot be
 * reached instead of asking for a sign-in, and the next answer that works
 * clears it.
 */

import { fakeBrowser } from "wxt/testing/fake-browser";
import type { Reply, Request, VaultStatus } from "../src/lib/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://polaris.example";

/** How the token endpoint answers right now; everything else is refused. */
let tokenAnswer: () => Response = () => new Response("", { status: 503 });

async function network(input: RequestInfo | URL): Promise<Response> {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ORIGIN}/vault/identity/connect/token`) return tokenAnswer();
    if (url === `${ORIGIN}/vault/api/accounts/revision-date`) return new Response("1");
    if (url.startsWith(`${ORIGIN}/vault/api/sync`)) {
        return new Response(
            JSON.stringify({ profile: { email: "ada@example.com" }, ciphers: [] }),
            {
                headers: { "content-type": "application/json" }
            }
        );
    }
    throw new TypeError("Failed to fetch");
}

async function ask(request: Request): Promise<Reply> {
    let answer: (reply: Reply) => void = () => {};
    const replied = new Promise<Reply>((resolve) => (answer = resolve));
    await fakeBrowser.runtime.onMessage.trigger(request, { id: fakeBrowser.runtime.id }, answer);
    return replied;
}

async function status(): Promise<VaultStatus> {
    const reply = await ask({ kind: "status" });
    if (!reply.ok || !("status" in reply)) throw new Error("no status");
    return reply.status;
}

async function storedRefresh(): Promise<unknown> {
    return (await fakeBrowser.storage.session.get("vault.refresh"))["vault.refresh"] ?? null;
}

beforeEach(async () => {
    fakeBrowser.reset();
    vi.resetModules();
    vi.stubGlobal("fetch", network);
    (fakeBrowser as unknown as { contextMenus: unknown }).contextMenus = {
        create() {},
        update: async () => {},
        removeAll: async () => {},
        onClicked: { addListener() {} }
    };
    // Signed in with an access token that has run out, so the next request
    // has to trade the refresh token.
    await fakeBrowser.storage.local.set({
        "server.origin": ORIGIN,
        "vault.email": "ada@example.com",
        "link.token": "connection"
    });
    await fakeBrowser.storage.session.set({
        "vault.refresh": "refresh-token",
        "vault.accountKey": "account-key",
        "vault.access": { token: "old", expiresAt: 0 }
    });
    await import("../src/entrypoints/background");
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("a refresh that gets no answer", () => {
    for (const [what, answer] of [
        ["a server error", () => new Response("", { status: 503 })],
        ["rate limiting", () => new Response("", { status: 429 })],
        [
            "no network",
            () => {
                throw new TypeError("Failed to fetch");
            }
        ]
    ] as const) {
        it(`keeps the session through ${what}, and says Polaris is out of reach`, async () => {
            tokenAnswer = answer;
            const reply = await ask({ kind: "sync" });
            expect(reply.ok).toBe(false);
            if (!reply.ok) expect(reply.error).toMatch(/still signed in/);

            expect(await storedRefresh()).toBe("refresh-token");
            const now = await status();
            expect(now.connected).toBe(true);
            expect(now.unreachable).toBe(true);
        });
    }

    it("clears the mark once a refresh works", async () => {
        tokenAnswer = () => new Response("", { status: 503 });
        await ask({ kind: "sync" });
        expect((await status()).unreachable).toBe(true);

        tokenAnswer = () =>
            new Response(
                JSON.stringify({
                    access_token: "access",
                    refresh_token: "rotated",
                    Key: "wrapped"
                }),
                { headers: { "content-type": "application/json" } }
            );
        expect((await ask({ kind: "sync" })).ok).toBe(true);
        const now = await status();
        expect(now.unreachable).toBe(false);
        expect(now.connected).toBe(true);
        expect(await storedRefresh()).toBe("rotated");
    });
});

describe("a refresh the server refuses", () => {
    it("ends the session, and is not reported as out of reach", async () => {
        tokenAnswer = () =>
            new Response(
                JSON.stringify({
                    error: "invalid_grant",
                    error_description: "Refresh token is invalid."
                }),
                { status: 400, headers: { "content-type": "application/json" } }
            );
        await ask({ kind: "sync" });
        expect(await storedRefresh()).toBeNull();
        const now = await status();
        expect(now.connected).toBe(false);
        expect(now.unreachable).toBe(false);
    });

    it("ends a session that had been marked out of reach, when the answer finally comes", async () => {
        tokenAnswer = () => new Response("", { status: 503 });
        await ask({ kind: "sync" });
        tokenAnswer = () => new Response("", { status: 401 });
        await ask({ kind: "sync" });
        expect(await storedRefresh()).toBeNull();
        expect((await status()).unreachable).toBe(false);
    });
});
