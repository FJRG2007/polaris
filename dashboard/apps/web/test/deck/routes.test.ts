/**
 * The Stream Deck's HTTP edges: only a key of kind "streamdeck" opens them,
 * each counts against a per-key throttle, a run's body is validated before the
 * service sees it, the state stream speaks server-sent events, and connecting
 * opens a device grant of the deck's kind with the deck's scopes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let principal: { keyId: string; userId: string; kind: string; scopes: string[] } | null = null;
let throttled = false;
const buckets: string[] = [];
const runs: unknown[] = [];
const opened: unknown[] = [];
const revoked: { userId: string; id: string }[] = [];

vi.mock("@polaris/db", () => ({
    prisma: { user: { findUnique: async () => ({ isAdmin: false }) } }
}));
vi.mock("@polaris/auth", () => ({
    revokeApiKey: async (userId: string, id: string) => void revoked.push({ userId, id })
}));
vi.mock("@polaris/config", async (original) => ({
    ...(await original<typeof import("@polaris/config")>()),
    loadEnv: () => ({ POLARIS_REPO: "FJRG2007/polaris" })
}));
vi.mock("@/lib/app-releases", () => ({
    streamDeckDownload: async () => ({
        url: "https://github.com/x/y",
        version: "0.1.4",
        files: []
    }),
    companionDownload: async () => null
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/api-key-auth", () => ({ authenticateApiKey: async () => principal }));
vi.mock("@/lib/i18n/locale-service", () => ({ getUserLocale: async () => "en-US" }));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async (key: string) => {
        buckets.push(key);
        return { ok: !throttled, retryAfterMs: 30_000 };
    }
}));
vi.mock("@/lib/request-context", () => ({
    clientIp: async () => "203.0.113.4",
    clientUserAgent: async () => "polaris-streamdeck/0.1.0",
    clientHost: async () => "polaris.example",
    hashForLog: (value: string | undefined) => value
}));
vi.mock("@/lib/cli/sign-in", () => ({
    openCliSignIn: async (input: unknown) => {
        opened.push(input);
        return {
            userCode: "BCDFGHJK",
            deviceCode: "d".repeat(64),
            expiresAt: new Date("2026-10-21T10:05:00Z"),
            pollMs: 2000
        };
    }
}));
// What the service reaches is not this file's business: only its edges are.
vi.mock("@/lib/deck/tool-call", () => ({ callTool: async () => ({ ok: false, message: null }) }));
vi.mock("@/lib/app-extensions/registry", () => ({ appDeckActions: async () => [] }));
vi.mock("@/lib/chat/chat-service", () => ({ unreadTotal: async () => ({ messages: 0 }) }));
vi.mock("@/lib/presence-service", () => ({}));
vi.mock("@/lib/chat/access", () => ({ reachableChannelIds: async () => new Set<string>() }));
vi.mock("@/lib/chat/live", () => ({ subscribeChatChanges: () => () => undefined }));
vi.mock("@/lib/deck/deck-service", async (original) => ({
    ...(await original<typeof import("@/lib/deck/deck-service")>()),
    deckCatalogue: async () => [{ id: "chat.unread" }],
    runDeckAction: async (_caller: unknown, input: unknown) => {
        runs.push(input);
        return { ok: true };
    },
    readDeckStates: async () => ({
        readings: [{ key: "a", state: { tone: "warn", value: "2" } }],
        chat: false
    })
}));

const actions = await import("@/app/api/deck/actions/route");
const run = await import("@/app/api/deck/run/route");
const state = await import("@/app/api/deck/state/route");
const authorize = await import("@/app/api/deck/authorize/route");
const session = await import("@/app/api/deck/session/route");

const DECK = { keyId: "k1", userId: "u1", kind: "streamdeck", scopes: ["chat.use"] };

function get(path: string): Request {
    return new Request(`https://polaris.example${path}`, {
        headers: { authorization: "Bearer plk_x" }
    });
}

function post(path: string, body: unknown): Request {
    return new Request(`https://polaris.example${path}`, {
        method: "POST",
        headers: { authorization: "Bearer plk_x", "content-type": "application/json" },
        body: JSON.stringify(body)
    });
}

beforeEach(() => {
    principal = DECK;
    throttled = false;
    buckets.length = 0;
    runs.length = 0;
    opened.length = 0;
    revoked.length = 0;
});

describe("deck routes", () => {
    it("answer 401 with no key, and with a key that is not a deck's", async () => {
        principal = null;
        expect((await actions.GET(get("/api/deck/actions"))).status).toBe(401);
        principal = { ...DECK, kind: "key" };
        expect((await actions.GET(get("/api/deck/actions"))).status).toBe(401);
        principal = { ...DECK, kind: "cli" };
        expect((await run.POST(post("/api/deck/run", { action: "chat.unread" }))).status).toBe(401);
    });

    it("hand a deck its catalogue and the newest releases, uncached, counted against its own key", async () => {
        const response = await actions.GET(get("/api/deck/actions"));
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({
            actions: [{ id: "chat.unread" }],
            latest: { streamdeck: "0.1.4", companion: null, downloadsPath: "/account/downloads" }
        });
        expect(buckets).toEqual(["deck-call:k1"]);
    });

    it("answer 429 with a wait once a deck is over its limit", async () => {
        throttled = true;
        const response = await actions.GET(get("/api/deck/actions"));
        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe("30");
    });

    it("validate a run's body before the service sees it", async () => {
        const bad = await run.POST(post("/api/deck/run", { action: "", step: 999 }));
        expect(bad.status).toBe(400);
        expect(runs).toHaveLength(0);
        const good = await run.POST(
            post("/api/deck/run", { action: "chat.send", options: { a: 1 } })
        );
        expect(good.status).toBe(200);
        expect(runs).toEqual([{ action: "chat.send", options: { a: 1 } }]);
    });

    it("stream state as server-sent events, starting with every watched key", async () => {
        const watch = Buffer.from(JSON.stringify([{ key: "a", action: "chat.unread" }])).toString(
            "base64url"
        );
        const controller = new AbortController();
        const response = await state.GET(
            new Request(`https://polaris.example/api/deck/state?watch=${watch}`, {
                headers: { authorization: "Bearer plk_x" },
                signal: controller.signal
            })
        );
        expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
        const reader = response.body!.getReader();
        let text = "";
        while (!text.includes("event: state")) {
            const { value } = await reader.read();
            text += new TextDecoder().decode(value);
        }
        controller.abort();
        expect(text).toContain("retry: 5000");
        expect(text).toContain(
            `event: state\ndata: ${JSON.stringify({ readings: [{ key: "a", state: { tone: "warn", value: "2" } }] })}\n\n`
        );
        expect(buckets).toEqual(["deck-stream:k1"]);
    });

    it("refuse a stream whose watch list does not parse", async () => {
        expect((await state.GET(get("/api/deck/state?watch=%25%25"))).status).toBe(400);
    });

    it("open a connection as a device grant of the deck's kind, with the deck's scopes", async () => {
        const response = await authorize.POST(
            post("/api/deck/authorize", { deviceName: "studio-pc" })
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            userCode: "BCDFGHJK",
            verificationPath: "/account/streamdeck",
            approvePath: "/account/streamdeck?code=BCDFGHJK"
        });
        expect(opened[0]).toMatchObject({
            kind: "streamdeck",
            scopes: [
                "chat.use",
                "deploy.read",
                "deploy.manage",
                "home.read",
                "home.control",
                "home.manage"
            ]
        });
        const refused = await authorize.POST(
            post("/api/deck/authorize", { deviceName: "studio-pc", scopes: ["vault.use"] })
        );
        expect(refused.status).toBe(400);
    });

    it("let a deck revoke its own key, and only a deck's key", async () => {
        const del = () =>
            new Request("https://polaris.example/api/deck/session", {
                method: "DELETE",
                headers: { authorization: "Bearer plk_x" }
            });
        expect((await session.DELETE(del())).status).toBe(204);
        expect(revoked).toEqual([{ userId: "u1", id: "k1" }]);
        principal = { ...DECK, kind: "key" };
        expect((await session.DELETE(del())).status).toBe(401);
        expect(revoked).toHaveLength(1);
    });
});
