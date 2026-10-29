import { describe, expect, it, vi } from "vitest";
import {
    createServerCheck,
    IDENTITY_PATH,
    MAX_BODY_BYTES,
    probeServer,
    readSmallJson
} from "../src/lib/server-identity";

const ORIGIN = "https://polaris.example.com";
const KEY = "A".repeat(43);

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers }
    });
}

function html(status = 200): Response {
    return new Response("<!doctype html><title>Welcome</title>", {
        status,
        headers: { "content-type": "text/html" }
    });
}

/** A fake network: one answer per path, recording every request it is sent. */
function network(routes: Record<string, () => Response | Promise<Response>>) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const path = new URL(url).pathname;
        const route = routes[path];
        return route ? route() : html(404);
    });
    return { fetch, calls };
}

describe("probeServer", () => {
    it("accepts the identity route's answer", async () => {
        const { fetch, calls } = network({ [IDENTITY_PATH]: () => json({ product: "polaris", protocol: 1 }) });
        expect(await probeServer(ORIGIN, undefined, fetch)).toEqual({
            kind: "polaris",
            name: null,
            version: null,
            legacy: false
        });
        expect(calls).toHaveLength(1);
    });

    it("reads a name and a version when the server sends them", async () => {
        const { fetch } = network({
            [IDENTITY_PATH]: () => json({ product: "polaris", protocol: 2, name: "Home", version: "1.4.0" })
        });
        expect(await probeServer(ORIGIN, undefined, fetch)).toMatchObject({ name: "Home", version: "1.4.0" });
    });

    it("sends no cookies, no referrer and follows no redirect", async () => {
        const { fetch, calls } = network({ [IDENTITY_PATH]: () => json({ product: "polaris", protocol: 1 }) });
        await probeServer(ORIGIN, undefined, fetch);
        expect(calls[0]!.init).toMatchObject({
            method: "GET",
            credentials: "omit",
            redirect: "manual",
            referrerPolicy: "no-referrer"
        });
    });

    it.each([
        ["another product", { product: "grafana", protocol: 1 }],
        ["no marker", { protocol: 1 }],
        ["a marker with the wrong type", { product: "polaris", protocol: "1" }],
        ["an empty object", {}]
    ])("refuses %s", async (_label, body) => {
        const { fetch, calls } = network({ [IDENTITY_PATH]: () => json(body) });
        expect(await probeServer(ORIGIN, undefined, fetch)).toEqual({ kind: "not-polaris" });
        expect(calls).toHaveLength(1);
    });

    it("refuses an HTML page served for every path, a parked domain, with one request", async () => {
        const { fetch, calls } = network({ [IDENTITY_PATH]: () => html(200) });
        expect(await probeServer(ORIGIN, undefined, fetch)).toEqual({ kind: "not-polaris" });
        expect(calls).toHaveLength(1);
    });

    it("refuses a host that answers 404 everywhere after asking the older signals", async () => {
        const { fetch, calls } = network({});
        expect(await probeServer(ORIGIN, undefined, fetch)).toEqual({ kind: "not-polaris" });
        expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
            IDENTITY_PATH,
            "/api/instance",
            "/api/health"
        ]);
    });

    it("refuses a JSON body over the cap", async () => {
        const big = { product: "polaris", protocol: 1, pad: "x".repeat(MAX_BODY_BYTES) };
        const { fetch } = network({ [IDENTITY_PATH]: () => json(big) });
        expect(await probeServer(ORIGIN, undefined, fetch)).toEqual({ kind: "not-polaris" });
    });

    it("reports a redirect, manual or followed to another origin", async () => {
        const manual = network({ [IDENTITY_PATH]: () => new Response(null, { status: 302, headers: { location: "https://portal.example" } }) });
        expect(await probeServer(ORIGIN, undefined, manual.fetch)).toEqual({ kind: "redirects" });

        const followed = network({
            [IDENTITY_PATH]: () => {
                const response = json({ product: "polaris", protocol: 1 });
                Object.defineProperty(response, "url", { value: "https://captive.example/login" });
                return response;
            }
        });
        expect(await probeServer(ORIGIN, undefined, followed.fetch)).toEqual({ kind: "redirects" });
    });

    describe("an install from before the identity route", () => {
        it("is recognized by /api/instance", async () => {
            const { fetch } = network({
                "/api/instance": () => json({ version: 1, id: "instance-1", publicKey: KEY, addresses: [ORIGIN] })
            });
            expect(await probeServer(ORIGIN, undefined, fetch)).toMatchObject({ kind: "polaris", legacy: true });
        });

        it("is recognized by /api/health when it predates /api/instance too", async () => {
            const { fetch } = network({ "/api/health": () => json({ status: "ok" }) });
            expect(await probeServer(ORIGIN, undefined, fetch)).toMatchObject({ kind: "polaris", legacy: true });
        });

        it("says it is starting when its database is not up", async () => {
            const { fetch } = network({ "/api/health": () => json({ status: "error", database: false }, 503) });
            expect(await probeServer(ORIGIN, undefined, fetch)).toEqual({ kind: "starting" });
        });

        it("refuses an /api/instance answer of the wrong shape", async () => {
            const { fetch } = network({ "/api/instance": () => json({ id: "x", publicKey: "short" }) });
            expect(await probeServer(ORIGIN, undefined, fetch)).toEqual({ kind: "not-polaris" });
        });

        it("refuses a health answer that is not Polaris's", async () => {
            const { fetch } = network({ "/api/health": () => json({ healthy: true }) });
            expect(await probeServer(ORIGIN, undefined, fetch)).toEqual({ kind: "not-polaris" });
        });

        it("moves past a rate-limited identity route", async () => {
            const { fetch } = network({
                [IDENTITY_PATH]: () => json({ error: "Too many requests." }, 429),
                "/api/health": () => json({ status: "ok" })
            });
            expect(await probeServer(ORIGIN, undefined, fetch)).toMatchObject({ kind: "polaris" });
        });
    });

    it("is unreachable when nothing answers", async () => {
        const fetch = vi.fn(async () => {
            throw new TypeError("Failed to fetch");
        });
        expect(await probeServer(ORIGIN, undefined, fetch)).toEqual({ kind: "unreachable" });
    });

    it("is unconfirmed when the host answered but an older signal could not be read", async () => {
        const fetch = vi.fn(async (url: string) => {
            if (url.endsWith("/api/health")) throw new TypeError("CORS");
            return html(404);
        });
        expect(await probeServer(ORIGIN, undefined, fetch)).toEqual({ kind: "unconfirmed" });
    });

    it("is unreachable once the time budget runs out", async () => {
        const fetch = vi.fn(
            (_url: string, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
                })
        );
        expect(await probeServer(ORIGIN, undefined, fetch, 30)).toEqual({ kind: "unreachable" });
    });

    it("throws when the caller aborts, so a stale answer is never shown", async () => {
        const controller = new AbortController();
        const fetch = vi.fn(
            (_url: string, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
                })
        );
        const verdict = probeServer(ORIGIN, controller.signal, fetch);
        controller.abort();
        await expect(verdict).rejects.toBeDefined();
    });
});

describe("readSmallJson", () => {
    it("refuses a declared length over the cap without reading it", async () => {
        const response = json({ ok: true }, 200, { "content-length": String(MAX_BODY_BYTES + 1) });
        expect(await readSmallJson(response)).toBeNull();
    });

    it("refuses a body that is not JSON", async () => {
        expect(await readSmallJson(html())).toBeNull();
    });

    it("reads a small JSON body", async () => {
        expect(await readSmallJson(json({ a: 1 }))).toEqual({ a: 1 });
    });
});

describe("createServerCheck", () => {
    it("asks an address once while the answer is fresh, and again after", async () => {
        let now = 0;
        const { fetch, calls } = network({ [IDENTITY_PATH]: () => json({ product: "polaris", protocol: 1 }) });
        const checker = createServerCheck(fetch, () => now);
        await checker.check(ORIGIN);
        await checker.check(ORIGIN);
        expect(calls).toHaveLength(1);
        expect(checker.peek(ORIGIN)).toMatchObject({ kind: "polaris" });
        now = 31_000;
        expect(checker.peek(ORIGIN)).toBeNull();
        await checker.check(ORIGIN);
        expect(calls).toHaveLength(2);
    });

    it("forgets an unreachable address sooner", async () => {
        let now = 0;
        const fetch = vi.fn(async () => {
            throw new TypeError("offline");
        });
        const checker = createServerCheck(fetch, () => now);
        await checker.check(ORIGIN);
        now = 6_000;
        expect(checker.peek(ORIGIN)).toBeNull();
    });

    it("remembers nothing from an aborted check", async () => {
        const controller = new AbortController();
        controller.abort();
        const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
            throw init?.signal?.reason;
        });
        const checker = createServerCheck(fetch);
        await expect(checker.check(ORIGIN, controller.signal)).rejects.toBeDefined();
        expect(checker.peek(ORIGIN)).toBeNull();
    });
});
