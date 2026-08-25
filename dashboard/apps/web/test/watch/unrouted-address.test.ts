/**
 * The outage that used to read as health: a hostname the edge routes nowhere.
 *
 * Traefik answers a name no router claims with a 404, and a 404 was counted as an
 * answer - so every deployed service could be unreachable on its domain while the
 * dashboard showed all of them up and nobody was told anything. What separates that
 * 404 from a real one is who wrote it, which is what these assert.
 */

import { checkDomain } from "@/lib/watch/health-probe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VACANT_HEADER, VACANT_HEADER_VALUE } from "@polaris/core";

const TARGET = { hostname: "app.plr.example.com", https: true };

/** Traefik's own 404, byte for byte, headers included. */
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

function answering(response: Response): void {
    vi.stubGlobal("fetch", vi.fn(async () => response));
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("an address the edge does not route", () => {
    it("is down, and says so in words an operator can act on", async () => {
        answering(edge404());

        const health = await checkDomain(TARGET);

        expect(health.status).toBe("down");
        expect(health.code).toBe(404);
        expect(health.detail).toBe("Not routed at the edge");
    });

    it("is flagged, so the routes can be written again without anyone asking", async () => {
        answering(edge404());

        expect((await checkDomain(TARGET)).notRouted).toBe(true);
    });

    it("counts the page for a name with nothing deployed on it the same way", async () => {
        answering(
            new Response("<html>nothing is deployed here</html>", {
                status: 404,
                headers: { "content-type": "text/html; charset=utf-8", [VACANT_HEADER]: VACANT_HEADER_VALUE }
            })
        );

        const health = await checkDomain(TARGET);

        expect(health.status).toBe("down");
        expect(health.notRouted).toBe(true);
    });
});

describe("an address that is serving", () => {
    it("leaves an app's own 404 alone", async () => {
        answering(new Response("<html>no such page</html>", { status: 404, headers: { "content-type": "text/html" } }));

        const health = await checkDomain(TARGET);

        expect(health.status).toBe("up");
        expect(health.notRouted).toBeUndefined();
    });

    it("leaves a plain-text 404 that is not the edge's alone", async () => {
        const body = "not found";
        answering(
            new Response(body, {
                status: 404,
                headers: { "content-type": "text/plain", "content-length": String(body.length) }
            })
        );

        expect((await checkDomain(TARGET)).status).toBe("up");
    });

    it("does not read a body big enough to be a page", async () => {
        const body = `404 page not found${" ".repeat(4096)}`;
        answering(
            new Response(body, {
                status: 404,
                headers: { "content-type": "text/plain", "content-length": String(body.length) }
            })
        );

        expect((await checkDomain(TARGET)).status).toBe("up");
    });

    it("does not read a body whose size the answer never declared", async () => {
        answering(new Response("404 page not found\n", { status: 404, headers: { "content-type": "text/plain" } }));

        expect((await checkDomain(TARGET)).status).toBe("up");
    });

    it("is up when it answers", async () => {
        answering(new Response("hello", { status: 200 }));

        const health = await checkDomain(TARGET);

        expect(health.status).toBe("up");
        expect(health.notRouted).toBeUndefined();
    });
});
