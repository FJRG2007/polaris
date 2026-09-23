/**
 * The endpoint the router knocks on, and who is allowed to.
 *
 * It takes no session, because the caller is mc-router inside the stack's own
 * network - the one deployed apps are deliberately not on. A request that came
 * through the edge carries the forwarded headers Traefik adds to everything, so
 * that is what tells a knock from the internet apart from a knock from the router,
 * and the answer to the internet is that this path does not exist.
 *
 * Everything else is deliberately unrevealing: whichever name was dialled and
 * whatever became of it, the answer is the same, because a different answer per
 * name is a way to find out which servers this Polaris runs.
 */

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const woken: string[] = [];
let outcome = "started";
let allowed = true;

vi.mock("@polaris-app/game-servers/src/lib/minecraft/wake-service", () => ({
    wakeForJoin: async (hostname: string) => {
        woken.push(hostname);
        return outcome;
    }
}));

vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => ({ ok: allowed, retryAfterMs: allowed ? 0 : 30_000 }),
    resetRateLimit: async () => undefined
}));

const { POST } = await import(
    "@polaris-app/game-servers/src/routes/api/minecraft/wake/route"
);

/** What the router really sends, as it was seen sending it. */
const KNOCK = {
    action: "up",
    serverAddress: "survival.mc.example.com",
    backend: "host.docker.internal:25571"
};

function knock(body: unknown, headers: Record<string, string> = {}): Request {
    return new Request("http://web:3000/api/minecraft/wake", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body)
    });
}

beforeEach(() => {
    woken.length = 0;
    outcome = "started";
    allowed = true;
});

describe("the knock", () => {
    it("starts the server that name belongs to", async () => {
        const answer = await POST(knock(KNOCK));
        expect(answer.status).toBe(200);
        expect(woken).toEqual(["survival.mc.example.com"]);
    });

    it("answers the same whatever became of it", async () => {
        outcome = "unknown";
        const unknown = await POST(knock(KNOCK));
        outcome = "started";
        const started = await POST(knock(KNOCK));
        expect(unknown.status).toBe(200);
        expect(await unknown.json()).toEqual(await started.json());
    });

    it("is not there for anybody coming through the edge", async () => {
        const answer = await POST(knock(KNOCK, { "x-forwarded-for": "203.0.113.9" }));
        expect(answer.status).toBe(404);
        expect(woken).toEqual([]);
    });

    it("never stops anything", async () => {
        // The router's own idle timer. Whether anybody is playing is a question the
        // schedule sweep asks the server itself, and a player who reached it on its
        // own port is nobody the router ever saw.
        const answer = await POST(knock({ ...KNOCK, action: "down" }));
        expect(answer.status).toBe(200);
        expect(woken).toEqual([]);
    });

    it("refuses a body that is not one", async () => {
        expect((await POST(knock("{"))).status).toBe(400);
        expect((await POST(knock({ action: "up" }))).status).toBe(400);
        expect((await POST(knock({ action: "sideways", serverAddress: "a" }))).status).toBe(400);
        expect(woken).toEqual([]);
    });

    it("stops listening to a name that knocks all day", async () => {
        allowed = false;
        const answer = await POST(knock(KNOCK));
        expect(answer.status).toBe(200);
        expect(woken).toEqual([]);
    });
});

const COMPOSE = readFileSync(new URL("../../../../docker/docker-compose.yml", import.meta.url), "utf8");

describe("the router is actually told to report it", () => {
    const router = COMPOSE.slice(COMPOSE.indexOf("\n  mc-router:"));

    it("posts to the path this route answers on", () => {
        expect(router).toContain("AUTO_SCALE_UP: \"true\"");
        expect(router).toContain("AUTO_SCALE_WEBHOOK_URL: http://web:3000/api/minecraft/wake");
    });

    it("says what a sleeping server looks like in the server list", () => {
        // Without these the router answers a ping for a sleeping server with
        // nothing, which a player reads as the server being gone.
        expect(router).toContain("AUTO_SCALE_ASLEEP_MOTD:");
        expect(router).toContain("AUTO_SCALE_LOADING_MOTD:");
    });

    it("never asks the router to scale anything down", () => {
        expect(router).not.toContain("AUTO_SCALE_DOWN");
    });
});
