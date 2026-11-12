/**
 * The forwardAuth server, run for real. `evaluate` is tested on its own in
 * authz.test.ts; what is checked here is the marshalling around it - that a block comes
 * back as the page a visitor can read (Traefik serves a non-2xx forwardAuth response to
 * the client as it stands), and that an allowed request still comes back as a bare 200.
 */

import { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { GuardConfig } from "../src/authz.js";
import { encodeGuardRule, wafBlockLookupToken } from "@polaris/core/waf";
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
    return await fetch(`${guardUrl}/authz`, { headers, redirect: "manual" });
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

describe("the login handoff", () => {
    it("is never stored, so a tab reopened the next day cannot replay it", async () => {
        const response = await check({
            "x-forwarded-proto": "https",
            "x-forwarded-host": "app.example.com",
            "x-forwarded-uri": "/dash",
            "x-polaris-waf": encodeGuardRule({ deny: [], requireLogin: true, rules: [] })
        });

        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toContain("/edge/authorize");
        expect(response.headers.get("cache-control")).toBe("no-store");
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

describe("the tailnet cookie filter", () => {
    async function filter(cookie?: string) {
        return await fetch(`${guardUrl}/tailnet-cookies`, {
            headers: cookie ? { cookie } : {}
        });
    }

    it("hands the app its own cookies and the edge's, never the dashboard's", async () => {
        const response = await filter(
            "__Secure-polaris.session_token=s; app_session=a; polaris-locale=es-ES; polaris.pass=p; polaris_lb=x; gh_manifest_state=g; theme=dark"
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("cookie")).toBe(
            "app_session=a; polaris.pass=p; polaris_lb=x; theme=dark"
        );
    });

    it("answers with no cookie when nothing is left, so the request loses its own", async () => {
        const response = await filter("polaris.session_token=s; __Host-Polaris.scope=o");
        expect(response.status).toBe(200);
        expect(response.headers.get("cookie")).toBeNull();
        expect((await filter()).headers.get("cookie")).toBeNull();
    });
});

describe("looking a block up by its reference", () => {
    const lookup = (reference: string, token?: string) =>
        fetch(`${guardUrl}/v1/blocks/${reference}`, {
            headers: token ? { authorization: `Bearer ${token}` } : {}
        });

    it("answers Polaris with what the block was", async () => {
        const blocked = await check({ ...DENIED, accept: "application/json" });
        const reference = /Reference ID: (\S+)/.exec(await blocked.text())?.[1] ?? "";
        const response = await lookup(reference, wafBlockLookupToken(cfg.secret));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            reference,
            ip: "203.0.113.5",
            host: "app.example.com"
        });
    });

    it("answers nobody else", async () => {
        const response = await lookup("3418858b-784f-463f-84ef-8b9013fbd592");
        expect(response.status).toBe(401);
        const forged = await lookup("3418858b-784f-463f-84ef-8b9013fbd592", "guess");
        expect(forged.status).toBe(401);
    });

    it("says it does not hold a reference it never issued", async () => {
        const response = await lookup(
            "3418858b-784f-463f-84ef-8b9013fbd592",
            wafBlockLookupToken(cfg.secret)
        );
        expect(response.status).toBe(404);
        expect(response.headers.get("content-type")).toContain("application/json");
    });
});
