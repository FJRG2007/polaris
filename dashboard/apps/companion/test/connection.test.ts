/**
 * The module's connection to Polaris, over a stubbed fetch: the device flow,
 * the catalogue, a 401, a 429, and the stream coming back after a drop.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection, type Host, type Phase } from "../src/connection";
import { PolarisClient, userAgent } from "../../streamdeck/src/polaris";

afterEach(() => {
    vi.useRealTimers();
});

const ADDRESS = "https://polaris.example.com";
const CATALOGUE = [
    {
        id: "chat.unread",
        kind: "state",
        area: "chat",
        label: "Unread",
        icon: "m",
        options: [],
        live: true
    }
];

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers }
    });
}

function recorder() {
    const phases: Phase["phase"][] = [];
    const saved: unknown[] = [];
    const readings: unknown[] = [];
    const host: Host = {
        phase: (phase) => phases.push(phase.phase),
        catalogue: () => undefined,
        readings: (list) => readings.push(...list),
        save: (credentials) => saved.push(credentials),
        log: () => undefined
    };
    return { host, phases, saved, readings };
}

describe("the user-agent", () => {
    it("names the module, so Polaris can tell the system it runs on", () => {
        expect(userAgent("0.1.0", "polaris-companion")).toMatch(
            /^polaris-companion\/0\.1\.0 \((win32|darwin|linux)[^)]*node /
        );
        expect(userAgent("1.0.0")).toMatch(/^polaris-streamdeck\/1\.0\.0 /);
    });
});

describe("signing in", () => {
    it("shows the code, waits for approval and keeps the key it is given", async () => {
        vi.useFakeTimers();
        const calls: string[] = [];
        const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            const path = String(url).slice(ADDRESS.length);
            calls.push(`${init?.method ?? "GET"} ${path}`);
            if (path === "/api/deck/authorize") {
                expect(new Headers(init?.headers).get("user-agent")).toMatch(
                    /^polaris-companion\//
                );
                return json({
                    userCode: "ABCD-EFGH",
                    deviceCode: "dev",
                    pollMs: 1000,
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                    approvePath: "/device?code=ABCD-EFGH"
                });
            }
            if (path === "/api/deck/authorize/claim") {
                return calls.filter((call) => call.endsWith("/claim")).length < 2
                    ? json({ status: "pending" })
                    : json({
                          status: "approved",
                          token: "plr_x",
                          keyId: "k1",
                          account: { name: "Ada", email: "ada@example.test" }
                      });
            }
            if (path === "/api/deck/actions") return json({ actions: CATALOGUE });
            return new Response(null, { status: 404 });
        });
        const { host, phases, saved } = recorder();
        const connection = new Connection(
            new PolarisClient("0.1.0", fetcher as typeof fetch, "polaris-companion"),
            host
        );
        const started = connection.start("polaris.example.com", null);
        await vi.advanceTimersByTimeAsync(2500);
        await started;
        expect(phases.slice(0, 1)).toEqual(["signing-in"]);
        expect(connection.current.phase).toBe("online");
        expect(saved).toEqual([
            { address: ADDRESS, token: "plr_x", keyId: "k1", account: "Ada (ada@example.test)" }
        ]);
        expect(connection.catalogue).toHaveLength(1);
        connection.stop();
    });

    it("does not reuse a key kept for a different Polaris", async () => {
        const fetcher = vi.fn(async (_url: string | URL | Request) => json({ error: "nope" }, 500));
        const { host, phases } = recorder();
        const connection = new Connection(
            new PolarisClient("0.1.0", fetcher as typeof fetch),
            host
        );
        await connection.start(ADDRESS, { address: "https://other.example.com", token: "t" });
        await vi.waitFor(() => expect(phases).toEqual(["sign-in-failed"]));
        expect(String(fetcher.mock.calls[0]?.[0])).toBe(`${ADDRESS}/api/deck/authorize`);
        connection.stop();
    });

    it("returns from start while the code waits for approval", async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn(async (url: string | URL | Request) =>
            String(url).endsWith("/api/deck/authorize")
                ? json({
                      userCode: "ABCD-EFGH",
                      deviceCode: "dev",
                      pollMs: 1000,
                      expiresAt: new Date(Date.now() + 60_000).toISOString(),
                      approvePath: "/device"
                  })
                : json({ status: "pending" })
        );
        const { host } = recorder();
        const connection = new Connection(
            new PolarisClient("0.1.0", fetcher as typeof fetch),
            host
        );
        let returned = false;
        void connection.start(ADDRESS, null).then(() => (returned = true));
        await vi.advanceTimersByTimeAsync(0);
        expect(returned).toBe(true);
        await vi.advanceTimersByTimeAsync(3000);
        expect(connection.current.phase).toBe("signing-in");
        connection.stop();
    });

    it("asks for a new code again after one is refused", async () => {
        vi.useFakeTimers();
        let opened = 0;
        const fetcher = vi.fn(async (url: string | URL | Request) => {
            if (!String(url).endsWith("/api/deck/authorize")) return json({ status: "denied" });
            opened += 1;
            return json({
                userCode: "ABCD-EFGH",
                deviceCode: "dev",
                pollMs: 1000,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                approvePath: "/device"
            });
        });
        const { host } = recorder();
        const connection = new Connection(
            new PolarisClient("0.1.0", fetcher as typeof fetch),
            host
        );
        await connection.start(ADDRESS, null);
        await vi.advanceTimersByTimeAsync(1500);
        expect(connection.current.phase).toBe("sign-in-failed");
        expect(connection.needsSignIn).toBe(true);
        void connection.signIn();
        await vi.advanceTimersByTimeAsync(0);
        expect(opened).toBe(2);
        expect(connection.current.phase).toBe("signing-in");
        expect(connection.needsSignIn).toBe(false);
        connection.stop();
    });

    it("revokes the key it held once a new sign-in is approved", async () => {
        vi.useFakeTimers();
        const calls: string[] = [];
        const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            const path = String(url).slice(ADDRESS.length);
            calls.push(
                `${init?.method ?? "GET"} ${path} ${new Headers(init?.headers).get("authorization") ?? ""}`
            );
            if (path === "/api/deck/authorize") {
                return json({
                    userCode: "ABCD-EFGH",
                    deviceCode: "dev",
                    pollMs: 1000,
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                    approvePath: "/device"
                });
            }
            if (path === "/api/deck/authorize/claim") {
                return json({
                    status: "approved",
                    token: "plr_new",
                    keyId: "k2",
                    account: { name: "Ada", email: "ada@example.test" }
                });
            }
            if (path === "/api/deck/session") return new Response(null, { status: 204 });
            if (path === "/api/deck/actions") return json({ actions: CATALOGUE });
            return new Response(null, { status: 404 });
        });
        const { host } = recorder();
        const connection = new Connection(
            new PolarisClient("0.1.0", fetcher as typeof fetch),
            host
        );
        await connection.start(ADDRESS, { address: ADDRESS, token: "plr_old", keyId: "k1" });
        const signedIn = connection.signIn();
        await vi.advanceTimersByTimeAsync(1500);
        await signedIn;
        expect(connection.credentials?.token).toBe("plr_new");
        const revoked = calls.filter((call) => call.startsWith("DELETE /api/deck/session"));
        expect(revoked).toHaveLength(1);
        expect(revoked[0]).toContain("plr_old");
        connection.stop();
    });

    it("refuses an address that is not one", async () => {
        const { host, phases } = recorder();
        const connection = new Connection(
            new PolarisClient("0.1.0", vi.fn() as typeof fetch),
            host
        );
        await connection.start("ftp://polaris", null);
        await connection.start("", null);
        expect(phases).toEqual(["invalid", "unset"]);
    });
});

describe("a signed-in connection", () => {
    const kept = { address: ADDRESS, token: "plr_x" };

    it("stops and asks to sign in again when the key is gone", async () => {
        const fetcher = vi.fn(async () => new Response(null, { status: 401 }));
        const { host } = recorder();
        const connection = new Connection(
            new PolarisClient("0.1.0", fetcher as typeof fetch),
            host
        );
        await connection.start(ADDRESS, kept);
        expect(connection.current.phase).toBe("unauthorized");
        expect(await connection.run("chat.unread", {})).toBeNull();
        connection.stop();
    });

    it("stays online when Polaris asks it to slow down, and says why", async () => {
        const fetcher = vi.fn(async (url: string | URL | Request) =>
            String(url).endsWith("/api/deck/actions")
                ? json({ actions: CATALOGUE })
                : json({ error: "Too many requests" }, 429, { "retry-after": "5" })
        );
        const { host } = recorder();
        const connection = new Connection(
            new PolarisClient("0.1.0", fetcher as typeof fetch),
            host
        );
        await connection.start(ADDRESS, kept);
        expect(await connection.run("chat.unread", {})).toEqual({
            ok: false,
            message: "Too many requests"
        });
        expect(connection.current.phase).toBe("online");
        connection.stop();
    });

    it("hands state frames on, and reconnects with backoff after a drop", async () => {
        vi.useFakeTimers();
        let streams = 0;
        const fetcher = vi.fn(async (url: string | URL | Request) => {
            const path = String(url).slice(ADDRESS.length);
            if (path === "/api/deck/actions") return json({ actions: CATALOGUE });
            streams += 1;
            if (streams === 1) return new Response(null, { status: 502 });
            const frame = `event: state\ndata: ${JSON.stringify({
                readings: [{ key: "var:chat_unread", state: { tone: "bad", value: "2" } }]
            })}\n\n`;
            return new Response(frame, { headers: { "content-type": "text/event-stream" } });
        });
        const { host, readings } = recorder();
        // No jitter, so the wait is exactly the backoff's first step.
        const connection = new Connection(
            new PolarisClient("0.1.0", fetcher as typeof fetch),
            host,
            () => 0.5
        );
        await connection.start(ADDRESS, kept);
        connection.watch([{ key: "var:chat_unread", action: "chat.unread", options: {} }]);
        await vi.advanceTimersByTimeAsync(500);
        expect(streams).toBe(1);
        expect(connection.current.phase).toBe("offline");
        await vi.advanceTimersByTimeAsync(2000);
        expect(streams).toBe(2);
        expect(readings).toEqual([{ key: "var:chat_unread", state: { tone: "bad", value: "2" } }]);
        expect(connection.current.phase).toBe("online");
        connection.stop();
    });
});
