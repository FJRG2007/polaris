/**
 * The CLI's HTTP edges: asking to sign in, collecting the answer, and signing
 * out with the key itself. The service behind them is tested on its own
 * (`sign-in.test.ts`); this is what the routes add - validation, throttling,
 * what reaches the CLI, and that a credential is never cached on the way.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let throttled = false;
let principal: { keyId: string; userId: string; kind: string } | null = null;
const opened: unknown[] = [];
let claim: Record<string, unknown> = { status: "pending" };
const audits: unknown[] = [];

vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: !throttled }) }));
vi.mock("@/lib/request-context", () => ({
    clientIp: async () => "203.0.113.4",
    clientUserAgent: async () => "polaris-cli/0.4.6 (linux; x64; node 22.0.0)",
    clientHost: async () => "polaris.example",
    hashForLog: (value: string | undefined) => value
}));
vi.mock("@/lib/audit-service", () => ({
    recordAudit: async (entry: unknown) => void audits.push(entry)
}));
vi.mock("@/lib/api-key-auth", () => ({ authenticateApiKey: async () => principal }));
vi.mock("@/lib/cli/sign-in", () => ({
    openCliSignIn: async (input: unknown) => {
        opened.push(input);
        return {
            userCode: "BCDFGHJK",
            deviceCode: "d".repeat(64),
            expiresAt: new Date("2026-10-04T10:05:00Z"),
            pollMs: 2000
        };
    },
    claimCliSignIn: async () => claim,
    endCliSignIn: async (who: { kind: string }) => who.kind === "cli"
}));

const authorize = await import("@/app/api/cli/authorize/route");
const claimRoute = await import("@/app/api/cli/authorize/claim/route");
const session = await import("@/app/api/cli/session/route");

function post(body: unknown): Request {
    return new Request("https://polaris.example/api/cli/authorize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
    });
}

beforeEach(() => {
    throttled = false;
    principal = null;
    opened.length = 0;
    audits.length = 0;
    claim = { status: "pending" };
});

describe("POST /api/cli/authorize", () => {
    it("opens a request and answers with the code and where to approve it", async () => {
        const response = await authorize.POST(
            post({ deviceName: "ada-laptop", clientVersion: "0.4.6" })
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            userCode: "BCDFGHJK",
            deviceCode: "d".repeat(64),
            expiresAt: "2026-10-04T10:05:00.000Z",
            pollMs: 2000,
            verificationPath: "/account/cli",
            approvePath: "/account/cli?code=BCDFGHJK"
        });
        // Every CLI scope when it does not say; what the request looked like is
        // read off the request, not the body.
        expect(opened[0]).toMatchObject({
            deviceName: "ada-laptop",
            scopes: ["deploy.read", "deploy.manage"],
            requestUserAgent: "polaris-cli/0.4.6 (linux; x64; node 22.0.0)",
            requestIp: "203.0.113.4"
        });
    });

    it("refuses a scope the CLI may not ask for", async () => {
        const response = await authorize.POST(post({ deviceName: "x", scopes: ["vault.use"] }));
        expect(response.status).toBe(400);
        expect(opened).toHaveLength(0);
    });

    it("refuses a body with no device name, or not JSON at all", async () => {
        expect((await authorize.POST(post({}))).status).toBe(400);
        const notJson = new Request("https://polaris.example/api/cli/authorize", {
            method: "POST",
            body: "nope"
        });
        expect((await authorize.POST(notJson)).status).toBe(400);
    });

    it("refuses a version string that is not a version", async () => {
        expect(
            (await authorize.POST(post({ deviceName: "x", clientVersion: "1.0; rm -rf" }))).status
        ).toBe(400);
    });

    it("is throttled per address", async () => {
        throttled = true;
        expect((await authorize.POST(post({ deviceName: "x" }))).status).toBe(429);
    });
});

describe("POST /api/cli/authorize/claim", () => {
    const poll = () =>
        claimRoute.POST(
            new Request("https://polaris.example/api/cli/authorize/claim", {
                method: "POST",
                body: JSON.stringify({ deviceCode: "d".repeat(64) })
            })
        );

    it("answers a wait as a status, not a failure", async () => {
        const response = await poll();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: "pending" });
    });

    it("hands the key over once approved, and nothing may cache it", async () => {
        claim = {
            status: "approved",
            token: "plk_abc.secret",
            keyId: "key-1",
            scopes: ["deploy.read"],
            account: { id: "u", name: "Ada", email: "ada@example.com" }
        };
        const response = await poll();
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toMatchObject({
            status: "approved",
            token: "plk_abc.secret",
            keyId: "key-1"
        });
    });

    it("refuses a missing device code", async () => {
        const response = await claimRoute.POST(
            new Request("https://polaris.example/api/cli/authorize/claim", {
                method: "POST",
                body: "{}"
            })
        );
        expect(response.status).toBe(400);
    });
});

describe("DELETE /api/cli/session", () => {
    const signOut = () =>
        session.DELETE(
            new Request("https://polaris.example/api/cli/session", { method: "DELETE" })
        );

    it("revokes a CLI sign-in with the key itself, and records it", async () => {
        principal = { keyId: "key-1", userId: "u", kind: "cli" };
        expect((await signOut()).status).toBe(204);
        expect(audits).toEqual([
            expect.objectContaining({ action: "account.cli.signedOut", targetId: "key-1" })
        ]);
    });

    it("leaves a key made for something else working", async () => {
        principal = { keyId: "key-2", userId: "u", kind: "key" };
        const response = await signOut();
        expect(response.status).toBe(409);
        expect(audits).toEqual([]);
    });

    it("answers a key that no longer works with 401", async () => {
        expect((await signOut()).status).toBe(401);
    });
});
