/**
 * The extension's connection to a Polaris account.
 *
 * What is tested here is what happens when an answer is not the happy one,
 * because that is where this can do harm: a poll that is still waiting must read
 * as waiting rather than as a failure, an approval that arrives without a token
 * must not be kept, and - the one that matters most - a server that could not be
 * reached must never be read as "somebody disconnected this browser", since that
 * throws away the vault with it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    checkLink,
    claimLink,
    endLink,
    fetchFace,
    openLink,
    readOrganizations
} from "../src/lib/link";

const ORIGIN = "https://polaris.example";

let asked: { url: string; method: string; body: string; auth: string | null }[] = [];

function answering(status: number, body: unknown): void {
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        asked.push({
            url: String(url),
            method: init?.method ?? "GET",
            body: String(init?.body ?? ""),
            auth: headers["authorization"] ?? null
        });
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => body
        } as Response;
    });
}

/** A server that is not there at all, which is a different thing from one that
 *  refused. */
function unreachable(): void {
    vi.stubGlobal("fetch", async () => {
        throw new TypeError("Failed to fetch");
    });
}

beforeEach(() => {
    asked = [];
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("asking to be connected", () => {
    it("sends the install's own id and reads back the code and where to approve it", async () => {
        answering(200, {
            userCode: "BCDFGHJK",
            deviceCode: "secret",
            expiresAt: "2026-09-17T10:05:00.000Z",
            pollMs: 2000,
            approveUrl: "/account/extension?code=BCDFGHJK"
        });

        const opened = await openLink(ORIGIN, { id: "install-1", name: "Chrome on Windows" });

        expect(asked[0]?.url).toBe("https://polaris.example/api/extension/authorize");
        expect(JSON.parse(asked[0]!.body)).toEqual({
            deviceId: "install-1",
            deviceName: "Chrome on Windows"
        });
        expect(opened).toMatchObject({
            userCode: "BCDFGHJK",
            deviceCode: "secret",
            approveUrl: "/account/extension?code=BCDFGHJK"
        });
    });

    it("holds the server's poll period to something this browser will wait", async () => {
        answering(200, { userCode: "BCDFGHJK", deviceCode: "secret", pollMs: 0 });
        expect((await openLink(ORIGIN, { id: "a", name: "b" }))?.pollMs).toBe(1000);

        answering(200, { userCode: "BCDFGHJK", deviceCode: "secret", pollMs: 600_000 });
        expect((await openLink(ORIGIN, { id: "a", name: "b" }))?.pollMs).toBe(30_000);
    });

    it("answers nothing for a server that does not know this route", async () => {
        answering(404, { error: "not found" });
        expect(await openLink(ORIGIN, { id: "a", name: "b" })).toBeNull();
    });
});

describe("collecting the approval", () => {
    it("reads a request still waiting as waiting", async () => {
        answering(200, { status: "pending" });
        expect(await claimLink(ORIGIN, "secret")).toEqual({ status: "pending" });
    });

    it("keeps waiting when the server could not be reached, or would not answer", async () => {
        unreachable();
        expect(await claimLink(ORIGIN, "secret")).toBeNull();

        answering(429, { error: "slow down" });
        expect(await claimLink(ORIGIN, "secret")).toBeNull();

        answering(502, "");
        expect(await claimLink(ORIGIN, "secret")).toBeNull();
    });

    it("hands over the token and the account when it was approved", async () => {
        answering(200, {
            status: "approved",
            token: "connection-token",
            account: { id: "u1", name: "Ada", email: "ada@example.com" }
        });

        expect(await claimLink(ORIGIN, "secret")).toEqual({
            status: "approved",
            token: "connection-token",
            account: { id: "u1", name: "Ada", email: "ada@example.com" }
        });
    });

    it("refuses an approval that carried no token rather than keeping a connection that cannot work", async () => {
        answering(200, { status: "approved", account: { id: "u1", email: "ada@example.com" } });
        expect(await claimLink(ORIGIN, "secret")).toEqual({ status: "expired" });

        answering(200, { status: "approved", token: "connection-token" });
        expect(await claimLink(ORIGIN, "secret")).toEqual({ status: "expired" });
    });

    it("reads a refusal as a refusal", async () => {
        answering(200, { status: "denied" });
        expect(await claimLink(ORIGIN, "secret")).toEqual({ status: "denied" });
    });
});

describe("asking whether the connection still stands", () => {
    it("presents the token and reads back what it reaches", async () => {
        answering(200, {
            connection: { id: "c1", name: "Chrome on Windows" },
            account: { id: "u1", name: "Ada", email: "ada@example.com" },
            can: { vault: true }
        });

        const state = await checkLink(ORIGIN, "connection-token");

        expect(asked[0]?.auth).toBe("Bearer connection-token");
        expect(state).toEqual({
            account: { id: "u1", name: "Ada", email: "ada@example.com" },
            connectionName: "Chrome on Windows",
            vault: true,
            organizations: []
        });
    });

    it("reads the organizations the account can switch to, with their vaults", async () => {
        answering(200, {
            connection: { id: "c1", name: "Chrome on Windows" },
            account: { id: "u1", name: "Ada", email: "ada@example.com" },
            organizations: [
                { id: "o1", name: "Acme", slug: "acme", vaultId: "v1" },
                { id: "o2", name: "Empty", slug: "empty", vaultId: null },
                { name: "No id" }
            ],
            can: { vault: true }
        });

        const state = await checkLink(ORIGIN, "connection-token");

        expect(state !== null && state !== "ended" ? state.organizations : null).toEqual([
            { id: "o1", name: "Acme", vaultId: "v1" },
            { id: "o2", name: "Empty", vaultId: null }
        ]);
    });

    it("says the connection has ended when the server refuses the token", async () => {
        answering(401, { error: "connection-ended" });
        expect(await checkLink(ORIGIN, "connection-token")).toBe("ended");
    });

    it("says nothing at all when the server could not be reached", async () => {
        // The whole point: this must not read as a disconnection, or a Polaris
        // behind a tunnel would take somebody's vault with it every time the
        // tunnel blinked.
        unreachable();
        expect(await checkLink(ORIGIN, "connection-token")).toBeNull();

        answering(503, "");
        expect(await checkLink(ORIGIN, "connection-token")).toBeNull();
    });

    it("says nothing for an answer that is not one", async () => {
        answering(200, { connection: { id: "c1" } });
        expect(await checkLink(ORIGIN, "connection-token")).toBeNull();
    });
});

describe("ending it from this side", () => {
    it("tells the server, with the token that proves which connection it is", async () => {
        answering(200, { ok: true });
        await endLink(ORIGIN, "connection-token");
        expect(asked[0]).toMatchObject({
            url: "https://polaris.example/api/extension/session",
            method: "DELETE",
            auth: "Bearer connection-token"
        });
    });

    it("does not throw at a server that is not there", async () => {
        unreachable();
        await expect(endLink(ORIGIN, "connection-token")).resolves.toBeUndefined();
    });
});

describe("organizations from an older server", () => {
    it("are none rather than a failure", () => {
        expect(readOrganizations(undefined)).toEqual([]);
        expect(readOrganizations("nope")).toEqual([]);
    });
});

describe("a face", () => {
    function picture(status: number, type: string, bytes: number[]): void {
        vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
            const headers = (init?.headers ?? {}) as Record<string, string>;
            asked.push({
                url: String(url),
                method: init?.method ?? "GET",
                body: "",
                auth: headers["authorization"] ?? null
            });
            return {
                ok: status >= 200 && status < 300,
                status,
                headers: new Headers({ "content-type": type }),
                arrayBuffer: async () => new Uint8Array(bytes).buffer
            } as unknown as Response;
        });
    }

    it("comes back as an image address, asked for with the token", async () => {
        picture(200, "image/png", [1, 2, 3]);
        expect(await fetchFace(ORIGIN, "connection-token", null)).toBe(
            "data:image/png;base64,AQID"
        );
        expect(asked[0]?.url).toBe(`${ORIGIN}/api/extension/avatar`);
        expect(asked[0]?.auth).toBe("Bearer connection-token");
    });

    it("asks for an organization's mark by its id", async () => {
        picture(200, "image/webp", [1]);
        await fetchFace(ORIGIN, "connection-token", "org 1");
        expect(asked[0]?.url).toBe(`${ORIGIN}/api/extension/avatar?org=org%201`);
    });

    it("is none when there is no picture, and unknown when nobody answered", async () => {
        picture(204, "", []);
        expect(await fetchFace(ORIGIN, "t", null)).toBeNull();
        unreachable();
        expect(await fetchFace(ORIGIN, "t", null)).toBeUndefined();
    });

    it("refuses anything that is not a picture", async () => {
        picture(200, "text/html", [60]);
        expect(await fetchFace(ORIGIN, "t", null)).toBeNull();
    });
});
