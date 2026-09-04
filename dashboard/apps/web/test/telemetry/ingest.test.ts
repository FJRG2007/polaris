/**
 * The endpoint a crashing program posts to.
 *
 * The second place anonymous outside traffic writes to Polaris, so the things
 * asserted here are the things that make that safe: one answer for every
 * outcome, so it cannot be used to find out which projects exist; a key that
 * only ever writes into the project it names; a limit per project; and a body
 * that is bounded before it is parsed.
 *
 * And the one that makes it useful at all - the path and the payload are the
 * ones a real Sentry client produces, because an ingest that only understands
 * its own idea of the format is an ingest that works until somebody points a
 * client at it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const captureEvent = vi.fn(async () => undefined);
const projectForIngest = vi.fn(async (number: number, key: string) =>
    number === 7 && key === "abc123def456abc123def456abc12345"
        ? { id: "p1", platform: null }
        : null
);
const rateLimit = vi.fn(async () => ({ ok: true, remaining: 1, resetAt: new Date() }));

vi.mock("@/lib/telemetry/store", () => ({ captureEvent }));
vi.mock("@/lib/telemetry/project-service", () => ({ projectForIngest }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit }));

const route = await import("../../src/app/api/telemetry/api/[projectId]/[kind]/route");

const KEY = "abc123def456abc123def456abc12345";

const crash = {
    event_id: "9f3a1c2e4b5d4f0a8c7b6e5d4c3b2a19",
    timestamp: new Date().toISOString(),
    level: "error",
    exception: {
        values: [
            {
                type: "TypeError",
                value: "Cannot read properties of undefined",
                stacktrace: { frames: [{ filename: "src/app.ts", function: "handler", lineno: 9, in_app: true }] }
            }
        ]
    }
};

/** An envelope exactly as a client writes one. */
function envelope(payload: unknown): string {
    const body = JSON.stringify(payload);
    return [
        JSON.stringify({ event_id: crash.event_id, sent_at: new Date().toISOString() }),
        JSON.stringify({ type: "event", length: body.length }),
        body
    ].join("\n");
}

async function post(
    path: string,
    body: string,
    params: { projectId: string; kind: string },
    headers: Record<string, string> = {}
) {
    return route.POST(new Request(`https://polaris.test${path}`, { method: "POST", body, headers }), {
        params: Promise.resolve(params)
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    rateLimit.mockResolvedValue({ ok: true, remaining: 1, resetAt: new Date() });
});

describe("an envelope from a real client", () => {
    it("is accepted and stored", async () => {
        const response = await post(
            `/api/telemetry/api/7/envelope/?sentry_key=${KEY}&sentry_version=7`,
            envelope(crash),
            { projectId: "7", kind: "envelope" }
        );
        expect(response.status).toBe(200);
        expect(captureEvent).toHaveBeenCalledOnce();
        expect(captureEvent.mock.calls[0]?.[1]).toMatchObject({ type: "TypeError" });
    });

    it("is accepted with the key in the header instead", async () => {
        await post("/api/telemetry/api/7/envelope/", envelope(crash), { projectId: "7", kind: "envelope" }, {
            "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${KEY}, sentry_client=sentry.javascript.node/8.0.0`
        });
        expect(captureEvent).toHaveBeenCalledOnce();
    });

    it("stores nothing for the items that are not failures", async () => {
        // A session and a client report ride the same envelope. Both are
        // legitimate and neither is a crash.
        await post(`/api/telemetry/api/7/envelope/?sentry_key=${KEY}`, envelope({ sid: "x", status: "ok" }), {
            projectId: "7",
            kind: "envelope"
        });
        expect(captureEvent).not.toHaveBeenCalled();
    });

    it("accepts the older store endpoint, which posts the event on its own", async () => {
        await post(`/api/telemetry/api/7/store/?sentry_key=${KEY}`, JSON.stringify(crash), {
            projectId: "7",
            kind: "store"
        });
        expect(captureEvent).toHaveBeenCalledOnce();
    });
});

describe("what it refuses, and how", () => {
    it("answers a wrong key exactly as it answers a right one", async () => {
        // Anything else turns this endpoint into a way to find out which
        // projects and which keys exist.
        const wrong = await post(`/api/telemetry/api/7/envelope/?sentry_key=${"f".repeat(32)}`, envelope(crash), {
            projectId: "7",
            kind: "envelope"
        });
        expect(wrong.status).toBe(200);
        expect(captureEvent).not.toHaveBeenCalled();
    });

    it("answers a project that does not exist the same way", async () => {
        const missing = await post(`/api/telemetry/api/999/envelope/?sentry_key=${KEY}`, envelope(crash), {
            projectId: "999",
            kind: "envelope"
        });
        expect(missing.status).toBe(200);
        expect(captureEvent).not.toHaveBeenCalled();
    });

    it("stores nothing when the project is over its limit", async () => {
        rateLimit.mockResolvedValue({ ok: false, remaining: 0, resetAt: new Date() });
        const limited = await post(`/api/telemetry/api/7/envelope/?sentry_key=${KEY}`, envelope(crash), {
            projectId: "7",
            kind: "envelope"
        });
        expect(limited.status).toBe(200);
        expect(captureEvent).not.toHaveBeenCalled();
    });

    it("counts the limit against the project, not the address", async () => {
        // One application behind a load balancer is one address; a browser
        // application is thousands of them.
        await post(`/api/telemetry/api/7/envelope/?sentry_key=${KEY}`, envelope(crash), {
            projectId: "7",
            kind: "envelope"
        });
        expect(rateLimit).toHaveBeenCalledWith("telemetry:p1", expect.any(Number), expect.any(Number));
    });

    it("does not read a body past the ceiling", async () => {
        const huge = await post(`/api/telemetry/api/7/envelope/?sentry_key=${KEY}`, envelope(crash), {
            projectId: "7",
            kind: "envelope"
        }, { "content-length": String(50 * 1024 * 1024) });
        expect(huge.status).toBe(200);
        expect(captureEvent).not.toHaveBeenCalled();
    });

    it("ignores a path that is not one of the two", async () => {
        await post(`/api/telemetry/api/7/something/?sentry_key=${KEY}`, envelope(crash), {
            projectId: "7",
            kind: "something"
        });
        expect(projectForIngest).not.toHaveBeenCalled();
    });

    it("ignores a project id that is not a number", async () => {
        await post(`/api/telemetry/api/x/envelope/?sentry_key=${KEY}`, envelope(crash), {
            projectId: "x",
            kind: "envelope"
        });
        expect(projectForIngest).not.toHaveBeenCalled();
    });
});

describe("the browser case", () => {
    it("answers the preflight, because a page reports cross-origin by definition", () => {
        const response = route.OPTIONS();
        expect(response.status).toBe(204);
        expect(response.headers.get("access-control-allow-origin")).toBe("*");
        expect(response.headers.get("access-control-allow-headers")).toContain("x-sentry-auth");
    });
});
