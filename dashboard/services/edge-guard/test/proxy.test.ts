/**
 * The proxy is the only part of the guard that sits in the data path, so the thing
 * worth protecting is that it stays invisible: a route it cannot rewrite, a body it
 * cannot hold, an upstream that fails - all of them have to come out the other side as
 * the app served them. Run against a real HTTP origin rather than a mocked one,
 * because most of what can go wrong here is Node's own header and stream handling
 * rather than our logic.
 */

import { AddressInfo } from "node:net";
import type { GuardConfig } from "../src/authz.js";
import { createServer, type Server } from "node:http";
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { createProxyServer, ORIGIN_HEADER } from "../src/proxy.js";
import { encodeGuardRule, signEdgeOrigin } from "@polaris/core/waf";
import {
    decodeObfuscatedEmail,
    EMAIL_DECODE_PATH,
    VACANT_DOWN_PATH,
    VACANT_HEADER,
    VACANT_HEADER_VALUE,
    VACANT_PATH
} from "@polaris/core";

const SECRET = "test-secret-at-least-16-chars";

const cfg: GuardConfig = {
    secret: SECRET,
    authorizeUrl: "https://polaris",
    cookieName: "polaris.edge",
    now: 1_800_000_000
};

/** What the fake origin serves next. Set per test. */
let respond: (url: string) => { status?: number; headers?: Record<string, string>; body: string };

let origin: Server;
let proxy: Server;
let originUrl = "";
let proxyUrl = "";

beforeAll(async () => {
    origin = createServer((req, res) => {
        const next = respond(req.url ?? "/");
        res.writeHead(next.status ?? 200, { "content-type": "text/html; charset=utf-8", ...next.headers });
        res.end(next.body);
    });
    await new Promise<void>((done) => origin.listen(0, "127.0.0.1", done));
    originUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;

    proxy = createProxyServer(() => cfg);
    await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((done) => proxy.close(() => done()));
    await new Promise<void>((done) => origin.close(() => done()));
});

/** Ask the proxy for a path, as Traefik would: signed upstream plus the route's rule. */
async function get(path: string, options: { obfuscate?: boolean; origin?: string } = {}) {
    const response = await fetch(`${proxyUrl}${path}`, {
        headers: {
            [ORIGIN_HEADER]: signEdgeOrigin(options.origin ?? originUrl, SECRET),
            "x-polaris-waf": encodeGuardRule({
                deny: [],
                requireLogin: false,
                emailObfuscation: options.obfuscate !== false,
                rules: []
            })
        }
    });
    return { status: response.status, headers: response.headers, body: await response.text() };
}

describe("rewriting", () => {
    it("hides an address and injects the decoder before </body>", async () => {
        respond = () => ({ body: "<html><body><p>hola@ejemplo.com</p></body></html>" });

        const res = await get("/");

        expect(res.status).toBe(200);
        expect(res.body).not.toContain("hola@ejemplo.com");
        expect(res.body).toContain(EMAIL_DECODE_PATH);
        expect(res.body.indexOf(EMAIL_DECODE_PATH)).toBeLessThan(res.body.indexOf("</body>"));
    });

    it("produces a token the decoder can read back", async () => {
        respond = () => ({ body: '<html><body><a href="mailto:hola@ejemplo.com">c</a></body></html>' });

        const token = /#([0-9a-f]+)"/.exec((await get("/")).body)?.[1] ?? "";

        expect(decodeObfuscatedEmail(token)).toBe("hola@ejemplo.com");
    });

    it("sets a content-length that matches the rewritten body", async () => {
        respond = () => ({ body: "<html><body><p>hola@ejemplo.com</p></body></html>" });

        const res = await get("/");

        expect(Number(res.headers.get("content-length"))).toBe(Buffer.byteLength(res.body));
    });

    it("serves the decoder itself", async () => {
        const response = await fetch(`${proxyUrl}${EMAIL_DECODE_PATH}`);

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("javascript");
        expect(await response.text()).toContain("DOMContentLoaded");
    });
});

describe("what it passes straight through", () => {
    it("leaves a page alone when the route has obfuscation off", async () => {
        const body = "<html><body><p>hola@ejemplo.com</p></body></html>";
        respond = () => ({ body });

        expect((await get("/", { obfuscate: false })).body).toBe(body);
    });

    it("leaves a page with no address alone, script included", async () => {
        const body = "<html><body><h1>Hola</h1></body></html>";
        respond = () => ({ body });

        const res = await get("/");

        expect(res.body).toBe(body);
        expect(res.body).not.toContain(EMAIL_DECODE_PATH);
    });

    it("never touches a response that is not HTML", async () => {
        const body = JSON.stringify({ email: "hola@ejemplo.com" });
        respond = () => ({ headers: { "content-type": "application/json" }, body });

        expect((await get("/api")).body).toBe(body);
    });

    it("honours Cache-Control: no-transform", async () => {
        const body = "<html><body><p>hola@ejemplo.com</p></body></html>";
        respond = () => ({ headers: { "cache-control": "public, no-transform" }, body });

        expect((await get("/")).body).toBe(body);
    });

    it("does not rewrite a non-200 response", async () => {
        const body = "<html><body><p>hola@ejemplo.com</p></body></html>";
        respond = () => ({ status: 404, body });

        const res = await get("/missing");

        expect(res.status).toBe(404);
        expect(res.body).toBe(body);
    });

    it("preserves the upstream's own headers", async () => {
        respond = () => ({ headers: { "x-app-header": "kept" }, body: "<html><body>hola@ejemplo.com</body></html>" });

        expect((await get("/")).headers.get("x-app-header")).toBe("kept");
    });
});

describe("the upstream header", () => {
    it("refuses a request that arrives without one", async () => {
        respond = () => ({ body: "<html></html>" });

        const response = await fetch(`${proxyUrl}/`);

        expect(response.status).toBe(502);
    });

    it("refuses an unsigned upstream, so it is not an open proxy", async () => {
        respond = () => ({ body: "<html></html>" });

        const response = await fetch(`${proxyUrl}/`, {
            headers: { [ORIGIN_HEADER]: "http://169.254.169.254" }
        });

        expect(response.status).toBe(502);
    });

    it("refuses an upstream signed with a different secret", async () => {
        respond = () => ({ body: "<html></html>" });

        const response = await fetch(`${proxyUrl}/`, {
            headers: { [ORIGIN_HEADER]: signEdgeOrigin(originUrl, "another-secret-entirely") }
        });

        expect(response.status).toBe(502);
    });

    it("answers 502 rather than hanging when the upstream is unreachable", async () => {
        const response = await fetch(`${proxyUrl}/`, {
            headers: {
                [ORIGIN_HEADER]: signEdgeOrigin("http://127.0.0.1:1", SECRET),
                "x-polaris-waf": encodeGuardRule({ deny: [], requireLogin: false, rules: [] })
            }
        });

        expect(response.status).toBe(502);
    });
});

/**
 * The one thing this listener answers without an upstream, because the whole point is
 * that there is not one. Reached with no signed origin, which is the request every
 * other path here is refused for.
 */
describe("a hostname with nothing behind it", () => {
    it("serves the page in place of the generic bad gateway", async () => {
        const response = await fetch(`${proxyUrl}${VACANT_PATH}`, {
            headers: { accept: "text/html", "x-forwarded-host": "gone.plr.example.com" }
        });
        const body = await response.text();

        expect(response.status).toBe(404);
        expect(response.headers.get(VACANT_HEADER)).toBe(VACANT_HEADER_VALUE);
        expect(body).toContain("There is nothing running here");
        expect(body).toContain("gone.plr.example.com");
        expect(body).not.toContain("Bad gateway");
    });

    it("serves the stopped-app page on the path an error page asks for", async () => {
        const response = await fetch(`${proxyUrl}${VACANT_DOWN_PATH}`, {
            headers: { accept: "text/html", "x-forwarded-host": "app.plr.example.com" }
        });

        expect(response.status).toBe(502);
        expect(await response.text()).toContain("This app is not running");
    });

    it("does not shadow an app's own paths", async () => {
        respond = () => ({ body: "<html>the app</html>" });

        expect((await get("/dashboard")).body).toContain("the app");
    });

    it("is not reachable on a live route, whatever the visitor asks for", async () => {
        // The bypass this guards: on a route whose responses this proxy rewrites, a
        // visitor asking for these paths by hand would otherwise be answered from above
        // the firewall - no denylist, no login, no ban - and told a healthy app was down.
        respond = () => ({ body: "<html>the app</html>" });

        for (const path of [VACANT_PATH, VACANT_DOWN_PATH, `${VACANT_PATH}?x=1`]) {
            const response = await get(path);

            expect(response.body).toContain("the app");
            expect(response.body).not.toContain("not running");
            expect(response.headers.get(VACANT_HEADER)).toBeNull();
        }
    });
});

describe("the firewall still applies", () => {
    /** A request from an address the route denies, as a browser would send it. */
    async function denied(accept: string) {
        respond = () => ({ body: "<html>should not be served</html>" });

        return await fetch(`${proxyUrl}/`, {
            headers: {
                [ORIGIN_HEADER]: signEdgeOrigin(originUrl, SECRET),
                "x-forwarded-for": "203.0.113.5",
                "x-forwarded-host": "app.example.com",
                accept,
                "x-polaris-waf": encodeGuardRule({ deny: ["203.0.113.0/24"], requireLogin: false, rules: [] })
            }
        });
    }

    it("blocks a denied address before reaching the upstream", async () => {
        const response = await denied("*/*");

        expect(response.status).toBe(403);
        expect(await response.text()).not.toContain("should not be served");
    });

    it("serves a browser the block page rather than a bare status", async () => {
        const response = await denied("text/html,*/*;q=0.8");
        const body = await response.text();

        expect(response.headers.get("content-type")).toContain("text/html");
        expect(body).toContain("you have been blocked");
        expect(body).toContain("app.example.com");
        expect(body).toContain("203.0.113.5");
    });
});
