/**
 * Polaris Terminal's HTTP edges: asking to sign in with the terminal's own
 * scopes, collecting the answer through the shared claim, and signing out with
 * the key itself. The service behind them is tested in `cli/sign-in.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let throttled = false;
let principal: { keyId: string; userId: string; kind: string } | null = null;
const opened: Record<string, unknown>[] = [];
const ended: { kind: string; asked?: string }[] = [];
const audits: unknown[] = [];
const buckets: string[] = [];

vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async (key: string) => {
        buckets.push(key);
        return { ok: !throttled };
    }
}));
vi.mock("@/lib/request-context", () => ({
    clientIp: async () => "203.0.113.4",
    clientUserAgent: async () => "polaris-terminal/0.2026.11.23 (win32; x64)",
    clientHost: async () => "polaris.example",
    hashForLog: (value: string | undefined) => value
}));
vi.mock("@/lib/audit-service", () => ({
    recordAudit: async (entry: unknown) => void audits.push(entry)
}));
vi.mock("@/lib/api-key-auth", () => ({ authenticateApiKey: async () => principal }));
vi.mock("@/lib/cli/sign-in", () => ({
    openCliSignIn: async (input: Record<string, unknown>) => {
        opened.push(input);
        return {
            userCode: "BCDFGHJK",
            deviceCode: "d".repeat(64),
            expiresAt: new Date("2026-11-23T10:05:00Z"),
            pollMs: 2000
        };
    },
    claimCliSignIn: async () => ({ status: "pending" }),
    endCliSignIn: async (who: { kind: string }, asked?: string) => {
        ended.push({ kind: who.kind, asked });
        return who.kind === (asked ?? "cli");
    }
}));

const authorize = await import("@/app/api/terminal/authorize/route");
const claim = await import("@/app/api/terminal/authorize/claim/route");
const cliClaim = await import("@/app/api/cli/authorize/claim/route");
const session = await import("@/app/api/terminal/session/route");

function post(body: unknown): Request {
    return new Request("https://polaris.example/api/terminal/authorize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
    });
}

function signOut(): Promise<Response> {
    return session.DELETE(
        new Request("https://polaris.example/api/terminal/session", {
            method: "DELETE",
            headers: { authorization: "Bearer plk_x" }
        })
    );
}

beforeEach(() => {
    throttled = false;
    principal = null;
    opened.length = 0;
    ended.length = 0;
    audits.length = 0;
    buckets.length = 0;
});

describe("POST /api/terminal/authorize", () => {
    it("opens a terminal request with every terminal scope and its own approval page", async () => {
        const response = await authorize.POST(
            post({ deviceName: "ada-desktop", clientVersion: "0.2026.11.23.10.00.oss_00" })
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            userCode: "BCDFGHJK",
            deviceCode: "d".repeat(64),
            expiresAt: "2026-11-23T10:05:00.000Z",
            pollMs: 2000,
            verificationPath: "/account/terminal",
            approvePath: "/account/terminal?code=BCDFGHJK"
        });
        expect(opened[0]).toMatchObject({
            kind: "terminal",
            deviceName: "ada-desktop",
            scopes: ["polar.use", "polar.spend", "terminal.control"],
            requestUserAgent: "polaris-terminal/0.2026.11.23 (win32; x64)",
            requestIp: "203.0.113.4"
        });
        expect(buckets).toEqual(["terminal-authorize:203.0.113.4"]);
    });

    it("keeps one copy of each scope asked for", async () => {
        await authorize.POST(post({ deviceName: "pc", scopes: ["polar.use", "polar.use"] }));
        expect(opened[0]?.["scopes"]).toEqual(["polar.use"]);
    });

    it("refuses scopes the terminal may not ask for, and a missing name", async () => {
        for (const body of [
            { deviceName: "pc", scopes: ["deploy.manage"] },
            { deviceName: "pc", scopes: [] },
            { deviceName: "  " },
            { deviceName: "pc", clientVersion: "1.0; rm -rf" },
            null
        ]) {
            expect((await authorize.POST(post(body))).status).toBe(400);
        }
        expect(opened).toHaveLength(0);
    });

    it("refuses once the address has asked too often", async () => {
        throttled = true;
        expect((await authorize.POST(post({ deviceName: "pc" }))).status).toBe(429);
        expect(opened).toHaveLength(0);
    });
});

it("collects through the CLI's own claim", () => {
    expect(claim.POST).toBe(cliClaim.POST);
});

describe("DELETE /api/terminal/session", () => {
    it("ends a terminal's own sign-in", async () => {
        principal = { keyId: "k1", userId: "u1", kind: "terminal" };
        expect((await signOut()).status).toBe(204);
        expect(ended).toEqual([{ kind: "terminal", asked: "terminal" }]);
        expect(audits).toEqual([
            expect.objectContaining({ action: "account.terminal.signedOut", targetId: "k1" })
        ]);
    });

    it("leaves any other key alone", async () => {
        for (const kind of ["cli", "key", "streamdeck"]) {
            principal = { keyId: "k2", userId: "u1", kind };
            expect((await signOut()).status).toBe(409);
        }
        expect(audits).toHaveLength(0);
    });

    it("answers 401 to a key that no longer works", async () => {
        expect((await signOut()).status).toBe(401);
    });
});
