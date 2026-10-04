/**
 * What a token refresh's answer means, read without a browser.
 *
 * The one distinction that matters: the server saying this session is over,
 * which ends it, against the server not being asked at all - offline, a
 * timeout, a 5xx, rate limiting - which must not. Both used to come back as
 * null and both signed somebody out of their vault.
 */

import { refresh } from "../src/lib/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

const BASE = "https://polaris.example/vault";

function answering(reply: () => Response | Promise<Response>): void {
    vi.stubGlobal("fetch", async () => reply());
}

const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("a refresh the server refused", () => {
    it("is rejected for the OAuth refusal Polaris gives a spent token", async () => {
        answering(() =>
            json({ error: "invalid_grant", error_description: "Refresh token is invalid." }, 400)
        );
        expect(await refresh(BASE, "spent")).toEqual({ kind: "rejected" });
    });

    it("is rejected for 401 and 403", async () => {
        for (const status of [401, 403]) {
            answering(() => new Response("", { status }));
            expect(await refresh(BASE, "spent")).toEqual({ kind: "rejected" });
        }
    });
});

describe("a refresh that never got an answer", () => {
    it("is unreachable when the network fails or times out", async () => {
        answering(() => {
            throw new TypeError("Failed to fetch");
        });
        expect(await refresh(BASE, "live")).toEqual({ kind: "unreachable" });
        answering(() => {
            throw new DOMException("The operation timed out.", "TimeoutError");
        });
        expect(await refresh(BASE, "live")).toEqual({ kind: "unreachable" });
    });

    it("is unreachable for a server error, rate limiting, or another 400", async () => {
        for (const reply of [
            () => new Response("", { status: 500 }),
            () => new Response("", { status: 502 }),
            () => new Response("", { status: 503 }),
            () => json({ error: "invalid_grant" }, 429),
            () => json({ error: "invalid_request" }, 400),
            () => new Response("<html>bad gateway</html>", { status: 400 })
        ]) {
            answering(reply);
            expect(await refresh(BASE, "live")).toEqual({ kind: "unreachable" });
        }
    });

    it("is unreachable for a success that is not a token", async () => {
        answering(() => new Response("<html>captive portal</html>", { status: 200 }));
        expect(await refresh(BASE, "live")).toEqual({ kind: "unreachable" });
    });
});

describe("a refresh that worked", () => {
    it("hands back the new token", async () => {
        answering(() =>
            json({ access_token: "access", refresh_token: "rotated", Key: "wrapped" }, 200)
        );
        const outcome = await refresh(BASE, "live");
        expect(outcome.kind).toBe("issued");
        if (outcome.kind === "issued") expect(outcome.token.refreshToken).toBe("rotated");
    });
});
