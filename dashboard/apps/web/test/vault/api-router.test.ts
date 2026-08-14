/**
 * The vault's route table, as a gate.
 *
 * The table is the only thing standing between an unauthenticated request and a
 * handler that assumes it has an account, so what is pinned here is the promise
 * it makes: a `bearer` route never runs its handler without one, and a handler
 * that asks for the principal on an open route fails loudly rather than reading
 * somebody else's vault.
 *
 * The matching cases are the second half. A path that 404s because a client
 * capitalized a segment is an unfindable bug, and 405 rather than 404 for a
 * known path with the wrong verb is what tells the next person which of the two
 * they got wrong.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticate = vi.fn(async () => null as { userId: string } | null);

vi.mock("@/lib/vault/auth", () => ({
    authenticateVault: authenticate,
    vaultUnauthorized: () => Response.json({ message: "Unauthorized" }, { status: 401 })
}));

const router = await import("../../src/lib/vault/api/router");

const handler = vi.fn(async () => Response.json({ ok: true }));

const ROUTES = [
    { method: "GET" as const, path: "api/sync", auth: "bearer" as const, handle: handler },
    {
        method: "POST" as const,
        path: "identity/connect/token",
        auth: "none" as const,
        handle: handler
    },
    {
        method: "GET" as const,
        path: "api/ciphers/:id/details",
        auth: "bearer" as const,
        handle: handler
    }
];

function request(method: string, url = "https://polaris.test/vault/api/sync"): Request {
    return new Request(url, { method });
}

beforeEach(() => {
    vi.clearAllMocks();
    authenticate.mockResolvedValue(null);
    handler.mockImplementation(async () => Response.json({ ok: true }));
});

describe("dispatchVault", () => {
    it("refuses a bearer route with no token, without running the handler", async () => {
        const response = await router.dispatchVault(ROUTES, request("GET"), ["api", "sync"]);
        expect(response.status).toBe(401);
        expect(handler).not.toHaveBeenCalled();
    });

    it("runs a bearer route once the token resolves to somebody", async () => {
        authenticate.mockResolvedValue({ userId: "user-1" });
        const response = await router.dispatchVault(ROUTES, request("GET"), ["api", "sync"]);
        expect(response.status).toBe(200);
        expect(handler.mock.calls[0]?.[0]).toMatchObject({ principal: { userId: "user-1" } });
    });

    it("runs an open route without asking who is calling", async () => {
        const response = await router.dispatchVault(
            ROUTES,
            request("POST", "https://polaris.test/vault/identity/connect/token"),
            ["identity", "connect", "token"]
        );
        expect(response.status).toBe(200);
        expect(authenticate).not.toHaveBeenCalled();
    });

    it("captures the named segments", async () => {
        authenticate.mockResolvedValue({ userId: "user-1" });
        await router.dispatchVault(ROUTES, request("GET"), [
            "api",
            "ciphers",
            "abc-123",
            "details"
        ]);
        expect(handler.mock.calls[0]?.[0].params).toEqual({ id: "abc-123" });
    });

    it("matches a path however a client capitalized it", async () => {
        authenticate.mockResolvedValue({ userId: "user-1" });
        const response = await router.dispatchVault(ROUTES, request("GET"), ["api", "Sync"]);
        expect(response.status).toBe(200);
    });

    it("does not treat a captured segment as case-insensitive", async () => {
        // An id is data, not a path: matching it loosely would let two different
        // ids reach the same row on a case-sensitive store.
        authenticate.mockResolvedValue({ userId: "user-1" });
        await router.dispatchVault(ROUTES, request("GET"), ["api", "ciphers", "AbC", "details"]);
        expect(handler.mock.calls[0]?.[0].params).toEqual({ id: "AbC" });
    });

    it("tells a wrong verb from a wrong path", async () => {
        const known = await router.dispatchVault(ROUTES, request("DELETE"), ["api", "sync"]);
        expect(known.status).toBe(405);
        const unknown = await router.dispatchVault(ROUTES, request("GET"), ["api", "nothing"]);
        expect(unknown.status).toBe(404);
    });

    it("answers an unknown path with a body a client can parse", async () => {
        const response = await router.dispatchVault(ROUTES, request("GET"), ["api", "nothing"]);
        await expect(response.json()).resolves.toMatchObject({ object: "error" });
    });

    it("does not match a path with the wrong number of segments", async () => {
        const response = await router.dispatchVault(ROUTES, request("GET"), [
            "api",
            "sync",
            "extra"
        ]);
        expect(response.status).toBe(404);
    });
});

describe("requirePrincipal", () => {
    it("throws rather than returning nothing on a route that forgot its auth", async () => {
        // The alternative is a handler quietly reading an empty user id, which
        // is how one account's request ends up answered with another's data.
        expect(() =>
            router.requirePrincipal({
                request: request("GET"),
                params: {},
                principal: null,
                query: new URLSearchParams()
            })
        ).toThrow();
    });
});

describe("readAnyBody", () => {
    it("reads the form encoding the token endpoint uses", async () => {
        const body = await router.readAnyBody(
            new Request("https://polaris.test/", {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: "grant_type=password&username=ana%40example.com"
            })
        );
        expect(body).toEqual({ grant_type: "password", username: "ana@example.com" });
    });

    it("reads JSON too, because some clients send it there", async () => {
        const body = await router.readAnyBody(
            new Request("https://polaris.test/", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ grant_type: "refresh_token", refresh_token: "abc" })
            })
        );
        expect(body).toEqual({ grant_type: "refresh_token", refresh_token: "abc" });
    });

    it("returns nothing rather than throwing on a body that is neither", async () => {
        const body = await router.readAnyBody(
            new Request("https://polaris.test/", { method: "POST", body: "not a form" })
        );
        expect(body).toEqual({});
    });
});
