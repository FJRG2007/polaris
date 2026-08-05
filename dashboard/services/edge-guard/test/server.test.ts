/**
 * The forwardAuth server, run for real. `evaluate` is tested on its own in
 * authz.test.ts; what is checked here is the marshalling around it - that a block comes
 * back as the page a visitor can read (Traefik serves a non-2xx forwardAuth response to
 * the client as it stands), and that an allowed request still comes back as a bare 200.
 */

import { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { GuardConfig } from "../src/authz.js";
import { encodeGuardRule } from "@polaris/core/waf";
import { createGuardServer } from "../src/server.js";
import { describe, expect, it, afterAll, beforeAll } from "vitest";

const cfg: GuardConfig = {
    secret: "test-secret-at-least-16-chars",
    authorizeUrl: "https://polaris",
    cookieName: "polaris.edge",
    now: 1_800_000_000
};

let guard: Server;
let guardUrl = "";

beforeAll(async () => {
    guard = createGuardServer(() => cfg);
    await new Promise<void>((done) => guard.listen(0, "127.0.0.1", done));
    guardUrl = `http://127.0.0.1:${(guard.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((done) => guard.close(() => done()));
});

/** Ask the guard about one request, as Traefik's forwardAuth would. */
async function check(headers: Record<string, string>) {
    return await fetch(`${guardUrl}/authz`, { headers });
}

const DENIED = {
    "x-forwarded-for": "203.0.113.5",
    "x-forwarded-host": "app.example.com",
    "x-polaris-waf": encodeGuardRule({ deny: ["203.0.113.0/24"], requireLogin: false, rules: [] })
};

describe("a blocked request", () => {
    it("comes back as the page, naming the site and the address", async () => {
        const response = await check({ ...DENIED, accept: "text/html,*/*;q=0.8" });
        const body = await response.text();

        expect(response.status).toBe(403);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(body).toContain("you have been blocked");
        expect(body).toContain("app.example.com");
        expect(body).toContain("203.0.113.5");
    });

    it("comes back as text for a client that did not ask for a page", async () => {
        const response = await check({ ...DENIED, accept: "application/json" });
        const body = await response.text();

        expect(response.status).toBe(403);
        expect(body).toContain("Reference ID:");
        expect(body).not.toContain("<html");
    });

    it("never says which rule matched", async () => {
        const body = await (await check({ ...DENIED, accept: "text/html" })).text();

        expect(body).not.toContain("denied ip");
    });
});

describe("an allowed request", () => {
    it("stays a bare 200, so Traefik forwards it", async () => {
        const response = await check({
            "x-forwarded-host": "app.example.com",
            "x-polaris-waf": encodeGuardRule({ deny: [], requireLogin: false, rules: [] })
        });

        expect(response.status).toBe(200);
        expect(await response.text()).toBe("");
    });
});
