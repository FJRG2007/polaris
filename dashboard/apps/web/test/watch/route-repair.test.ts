/**
 * When a pass over the domains writes the edge's routes again.
 *
 * Finding an address the edge routes nowhere is the one outage on that page Polaris
 * can end by itself, so a pass that finds one republishes the routes. What that must
 * not become is a rewrite of the live routing file once a minute forever: an app that
 * runs on a remote server is served by that server's own edge and is deliberately kept
 * out of the local file, so it answers the edge's 404 for as long as it exists and no
 * rewrite of that file is what it is waiting for.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface DomainRow extends Record<string, unknown> {
    id: string;
    hostname: string;
    https: boolean;
    pathPrefix: string | null;
    healthFailures: number;
    healthAlertedAt: Date | null;
    application: { target: { kind: string } };
}

let domains: DomainRow[] = [];
/** How many times the pass asked for the routes to be written again. */
let republished = 0;

vi.mock("@polaris/db", () => ({
    prisma: {
        domain: {
            findMany: async () => domains,
            update: async () => ({})
        }
    }
}));

vi.mock("@/lib/deploy-service", () => ({
    syncAppRoutes: async () => {
        republished += 1;
    }
}));

vi.mock("@/lib/notifications/domain-events", () => ({
    notifyDomainHealthChanged: async () => undefined
}));

/** A domain of an app that runs where the caller says. */
function domain(id: string, kind: "local" | "remote"): DomainRow {
    return {
        id,
        hostname: `${id}.plr.example.com`,
        https: true,
        pathPrefix: null,
        healthFailures: 0,
        healthAlertedAt: null,
        application: { target: { kind } }
    };
}

/** Traefik's own 404, which is how it says no router claims the name. */
function edge404(): Response {
    const body = "404 page not found\n";
    return new Response(body, {
        status: 404,
        headers: {
            "content-type": "text/plain; charset=utf-8",
            "content-length": String(body.length)
        }
    });
}

async function pass(): Promise<void> {
    const { probeAllDomains } = await import("@/lib/watch/health-probe");
    await probeAllDomains();
}

beforeEach(() => {
    republished = 0;
    domains = [];
    vi.resetModules();
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => edge404())
    );
});

describe("an unrouted address the local edge serves", () => {
    it("has the routes written again", async () => {
        domains = [domain("shop", "local")];

        await pass();

        expect(republished).toBe(1);
    });

    it("is not written again on the pass that follows", async () => {
        domains = [domain("shop", "local")];

        await pass();
        await pass();
        await pass();

        expect(republished).toBe(1);
    });
});

describe("an unrouted address served by another server's edge", () => {
    it("is left to that edge, not repaired here every minute", async () => {
        domains = [domain("remote-app", "remote")];

        await pass();
        await pass();

        expect(republished).toBe(0);
    });

    it("does not hide an address this edge could still repair", async () => {
        domains = [domain("remote-app", "remote"), domain("shop", "local")];

        await pass();

        expect(republished).toBe(1);
    });
});

describe("addresses that answer", () => {
    it("leave the routing file alone", async () => {
        domains = [domain("shop", "local")];
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("hello", { status: 200 }))
        );

        await pass();

        expect(republished).toBe(0);
    });
});
