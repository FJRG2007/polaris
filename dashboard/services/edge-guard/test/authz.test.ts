import { describe, it, expect } from "vitest";
import { evaluate, type GuardConfig } from "../src/authz.js";
import { encodeGuardRule, signEdgeToken } from "@polaris/core/waf";
import { buildWafIntel, indexWafIntel, type WafCustomRule, type WafIntelEntry } from "@polaris/core";

const NOW = 1_800_000_000;
const SECRET = "test-secret-at-least-16-chars";
const HOST = "app.example.com";
const cfg: GuardConfig = { secret: SECRET, authorizeUrl: "https://polaris", cookieName: "polaris.edge", now: NOW };

/** A Cookie header carrying a signed edge token bound to `aud`, expiring at `exp`. */
function tokenCookie(sub: string, aud: string, exp: number): string {
    return `polaris.edge=${signEdgeToken({ sub, aud, exp }, SECRET)}`;
}

describe("evaluate - denylist", () => {
    it("allows when there is no rule", () => {
        expect(evaluate({}, cfg)).toEqual({ status: 200 });
    });

    it("allows an IP that is not on the denylist", () => {
        const wafHeader = encodeGuardRule({ deny: ["10.0.0.0/8"], requireLogin: false, rules: [] });
        expect(evaluate({ wafHeader, forwardedFor: "203.0.113.5" }, cfg)).toEqual({ status: 200 });
    });

    it("blocks an IP that matches a deny CIDR", () => {
        const wafHeader = encodeGuardRule({ deny: ["10.0.0.0/8"], requireLogin: false, rules: [] });
        expect(evaluate({ wafHeader, forwardedFor: "10.2.3.4" }, cfg).status).toBe(403);
    });

    it("blocks an exact deny IP", () => {
        const wafHeader = encodeGuardRule({ deny: ["203.0.113.5"], requireLogin: false, rules: [] });
        expect(evaluate({ wafHeader, forwardedFor: "203.0.113.5" }, cfg).status).toBe(403);
    });

    it("uses the leftmost X-Forwarded-For entry as the client IP", () => {
        const wafHeader = encodeGuardRule({ deny: ["10.0.0.0/8"], requireLogin: false, rules: [] });
        expect(evaluate({ wafHeader, forwardedFor: "10.2.3.4, 70.0.0.1" }, cfg).status).toBe(403);
    });

    it("fails closed when a denylist exists but the client IP is unknown", () => {
        const wafHeader = encodeGuardRule({ deny: ["10.0.0.0/8"], requireLogin: false, rules: [] });
        expect(evaluate({ wafHeader }, cfg).status).toBe(403);
    });
});

describe("evaluate - require login", () => {
    it("redirects to login when no token is present", () => {
        const wafHeader = encodeGuardRule({ deny: [], requireLogin: true, rules: [] });
        const decision = evaluate({ wafHeader, forwardedProto: "https", forwardedHost: HOST, forwardedUri: "/dash" }, cfg);
        expect(decision.status).toBe(302);
        expect(decision).toMatchObject({
            location: "https://polaris/edge/authorize?redirect=https%3A%2F%2Fapp.example.com%2Fdash"
        });
    });

    it("allows with a valid host-bound token", () => {
        const wafHeader = encodeGuardRule({ deny: [], requireLogin: true, rules: [] });
        const cookie = tokenCookie("user-1", HOST, NOW + 3600);
        expect(evaluate({ wafHeader, forwardedHost: HOST, cookie }, cfg)).toEqual({ status: 200 });
    });

    it("redirects when the token is bound to a different host", () => {
        const wafHeader = encodeGuardRule({ deny: [], requireLogin: true, rules: [] });
        const cookie = tokenCookie("user-1", "other.example.com", NOW + 3600);
        expect(evaluate({ wafHeader, forwardedHost: HOST, cookie }, cfg).status).toBe(302);
    });

    it("redirects when the token is expired", () => {
        const wafHeader = encodeGuardRule({ deny: [], requireLogin: true, rules: [] });
        const cookie = tokenCookie("user-1", HOST, NOW - 1);
        expect(evaluate({ wafHeader, forwardedHost: HOST, cookie }, cfg).status).toBe(302);
    });

    it("redirects when the token signature is forged", () => {
        const wafHeader = encodeGuardRule({ deny: [], requireLogin: true, rules: [] });
        const forged = signEdgeToken({ sub: "user-1", aud: HOST, exp: NOW + 3600 }, "wrong-secret");
        expect(evaluate({ wafHeader, forwardedHost: HOST, cookie: `polaris.edge=${forged}` }, cfg).status).toBe(302);
    });

    it("fails closed when the host is unknown", () => {
        const wafHeader = encodeGuardRule({ deny: [], requireLogin: true, rules: [] });
        expect(evaluate({ wafHeader }, cfg).status).toBe(403);
    });

    it("treats a malformed rule header as fail-closed (require login)", () => {
        const decision = evaluate({ wafHeader: "not-base64-json!!", forwardedHost: HOST }, cfg);
        expect(decision.status).toBe(302);
    });

    it("blocks a denied IP even when it carries a valid login token", () => {
        const wafHeader = encodeGuardRule({ deny: ["10.0.0.0/8"], requireLogin: true, rules: [] });
        const cookie = tokenCookie("user-1", HOST, NOW + 3600);
        expect(evaluate({ wafHeader, forwardedHost: HOST, forwardedFor: "10.9.9.9", cookie }, cfg).status).toBe(403);
    });
});

describe("evaluate - custom rules", () => {
    /** A rule set on the wire, as the router encodes one. */
    function rules(...entries: { name: string; action: "block" | "allow"; conditions: unknown[] }[]): string {
        return encodeGuardRule({ deny: [], requireLogin: false, rules: entries as never });
    }

    it("blocks a request a rule matches, naming the rule", () => {
        const wafHeader = rules({
            name: "no wp-admin",
            action: "block",
            conditions: [{ field: "path", operator: "starts_with", values: ["/wp-admin"] }]
        });
        const decision = evaluate({ wafHeader, forwardedHost: HOST, forwardedUri: "/wp-admin/x.php" }, cfg);
        expect(decision).toEqual({ status: 403, reason: "rule: no wp-admin" });
    });

    it("leaves a request no rule matches to the rest of the guard", () => {
        const wafHeader = rules({
            name: "no wp-admin",
            action: "block",
            conditions: [{ field: "path", operator: "starts_with", values: ["/wp-admin"] }]
        });
        expect(evaluate({ wafHeader, forwardedHost: HOST, forwardedUri: "/" }, cfg)).toEqual({ status: 200 });
    });

    it("reads the method Traefik forwarded, not the guard's own", () => {
        const wafHeader = rules({
            name: "no writes",
            action: "block",
            conditions: [{ field: "method", operator: "equals", values: ["POST"] }]
        });
        expect(evaluate({ wafHeader, forwardedHost: HOST, forwardedMethod: "POST" }, cfg).status).toBe(403);
        expect(evaluate({ wafHeader, forwardedHost: HOST, forwardedMethod: "GET" }, cfg).status).toBe(200);
    });

    it("admits a request an allow rule matches without sending it round the login", () => {
        // The rule set is meant to be the last word on a request it matches; bouncing
        // it through a login it was explicitly admitted past would be neither.
        const wafHeader = encodeGuardRule({
            deny: [],
            requireLogin: true,
            rules: [
                {
                    name: "health checks",
                    enabled: true,
                    action: "allow",
                    conditions: [{ field: "path", operator: "equals", values: ["/healthz"] }]
                }
            ]
        });
        expect(evaluate({ wafHeader, forwardedHost: HOST, forwardedUri: "/healthz" }, cfg)).toEqual({ status: 200 });
        expect(evaluate({ wafHeader, forwardedHost: HOST, forwardedUri: "/" }, cfg).status).toBe(302);
    });

    it("blocks a denied address before any rule can allow it", () => {
        const wafHeader = encodeGuardRule({
            deny: ["10.0.0.0/8"],
            requireLogin: false,
            rules: [
                {
                    name: "everything",
                    enabled: true,
                    action: "allow",
                    conditions: [{ field: "path", operator: "starts_with", values: ["/"] }]
                }
            ]
        });
        expect(evaluate({ wafHeader, forwardedHost: HOST, forwardedFor: "10.1.2.3", forwardedUri: "/" }, cfg).status).toBe(403);
    });
});

describe("evaluate - login callback", () => {
    it("sets a same-domain cookie and redirects to the original URL", () => {
        const wafHeader = encodeGuardRule({ deny: [], requireLogin: true, rules: [] });
        const token = signEdgeToken({ sub: "user-1", aud: HOST, exp: NOW + 3600 }, SECRET);
        const uri = `/edge/callback?token=${token}&redirect=${encodeURIComponent(`https://${HOST}/dash`)}`;
        const decision = evaluate({ wafHeader, forwardedProto: "https", forwardedHost: HOST, forwardedUri: uri }, cfg);
        expect(decision.status).toBe(302);
        expect(decision).toMatchObject({ location: `https://${HOST}/dash` });
        expect((decision as { setCookie?: string }).setCookie).toContain(`polaris.edge=${token}`);
        expect((decision as { setCookie?: string }).setCookie).toContain("Secure");
    });

    it("confines the callback redirect to the app's own host", () => {
        const wafHeader = encodeGuardRule({ deny: [], requireLogin: true, rules: [] });
        const token = signEdgeToken({ sub: "user-1", aud: HOST, exp: NOW + 3600 }, SECRET);
        const uri = `/edge/callback?token=${token}&redirect=${encodeURIComponent("https://evil.example.com/")}`;
        const decision = evaluate({ wafHeader, forwardedProto: "https", forwardedHost: HOST, forwardedUri: uri }, cfg);
        expect(decision).toMatchObject({ status: 302, location: `https://${HOST}/` });
    });

    it("omits Secure on a plain-http edge", () => {
        const wafHeader = encodeGuardRule({ deny: [], requireLogin: true, rules: [] });
        const token = signEdgeToken({ sub: "user-1", aud: HOST, exp: NOW + 3600 }, SECRET);
        const uri = `/edge/callback?token=${token}&redirect=${encodeURIComponent(`http://${HOST}/`)}`;
        const decision = evaluate({ wafHeader, forwardedProto: "http", forwardedHost: HOST, forwardedUri: uri }, cfg);
        expect((decision as { setCookie?: string }).setCookie).not.toContain("Secure");
    });

    it("redirects to login when the callback token is invalid", () => {
        const wafHeader = encodeGuardRule({ deny: [], requireLogin: true, rules: [] });
        const uri = `/edge/callback?token=bogus&redirect=${encodeURIComponent(`https://${HOST}/`)}`;
        const decision = evaluate({ wafHeader, forwardedProto: "https", forwardedHost: HOST, forwardedUri: uri }, cfg);
        expect(decision.status).toBe(302);
        expect(decision).toMatchObject({ location: expect.stringContaining("/edge/authorize") });
    });
});

describe("evaluate - address intelligence", () => {
    const ban: WafIntelEntry = { reason: "ban", until: NOW * 1000 + 60_000, note: "404 flood" };
    const withIntel = (entries: (readonly [string, WafIntelEntry])[]): GuardConfig => ({
        ...cfg,
        intel: indexWafIntel(buildWafIntel(entries, NOW * 1000))
    });

    it("blocks a banned address with no rule of any kind attached", () => {
        const decision = evaluate({ forwardedFor: "203.0.113.7" }, withIntel([["203.0.113.7", ban]]));
        expect(decision.status).toBe(403);
        expect(decision).toMatchObject({ reason: expect.stringContaining("404 flood") });
    });

    it("lets everyone else through", () => {
        expect(evaluate({ forwardedFor: "203.0.113.8" }, withIntel([["203.0.113.7", ban]]))).toEqual({
            status: 200
        });
    });

    it("blocks a Tor exit and says so", () => {
        const tor: WafIntelEntry = { reason: "tor", until: null };
        const decision = evaluate({ forwardedFor: "198.51.100.4" }, withIntel([["198.51.100.4", tor]]));
        expect(decision).toMatchObject({ status: 403, reason: "intel: tor" });
    });

    it("stops blocking once the ban lapses", () => {
        const config = withIntel([["203.0.113.7", ban]]);
        const later: GuardConfig = { ...config, now: NOW + 120 };
        expect(evaluate({ forwardedFor: "203.0.113.7" }, later)).toEqual({ status: 200 });
    });

    it("outranks a require-login route: a banned address is not offered the login", () => {
        const wafHeader = encodeGuardRule({ deny: [], requireLogin: true, rules: [] });
        const decision = evaluate(
            { wafHeader, forwardedFor: "203.0.113.7", forwardedHost: HOST },
            withIntel([["203.0.113.7", ban]])
        );
        expect(decision.status).toBe(403);
    });

    it("does not block when the snapshot could not be read", () => {
        const empty: GuardConfig = { ...cfg, intel: indexWafIntel("corrupt") };
        expect(evaluate({ forwardedFor: "203.0.113.7" }, empty)).toEqual({ status: 200 });
    });
});

/**
 * The browser integrity check sits after the custom rules on purpose: it is a
 * heuristic, and an operator who finds the case it is wrong about must be able to
 * write an exception above it rather than switch the whole thing off.
 */
describe("browser integrity", () => {
    const CHROME =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

    function armed(rules: WafCustomRule[] = []) {
        return encodeGuardRule({ deny: [], requireLogin: false, browserIntegrity: true, rules });
    }

    it("does nothing until it is armed", () => {
        const wafHeader = encodeGuardRule({ deny: [], requireLogin: false, rules: [] });

        expect(evaluate({ wafHeader, forwardedHost: "app.test" }, cfg).status).toBe(200);
    });

    it("blocks a request with no user agent", () => {
        const decision = evaluate({ wafHeader: armed(), forwardedHost: "app.test" }, cfg);

        expect(decision.status).toBe(403);
    });

    it("blocks a forged browser that sends no Accept header", () => {
        const decision = evaluate(
            { wafHeader: armed(), forwardedHost: "app.test", userAgent: CHROME },
            cfg
        );

        expect(decision.status).toBe(403);
    });

    it("admits a real browser", () => {
        const decision = evaluate(
            {
                wafHeader: armed(),
                forwardedHost: "app.test",
                userAgent: CHROME,
                accept: "text/html",
                acceptLanguage: "es-ES",
                acceptEncoding: "gzip"
            },
            cfg
        );

        expect(decision.status).toBe(200);
    });

    it("admits an honest non-browser client, so an API on the same scope keeps working", () => {
        const decision = evaluate(
            { wafHeader: armed(), forwardedHost: "app.test", userAgent: "curl/8.7.1" },
            cfg
        );

        expect(decision.status).toBe(200);
    });

    it("lets a custom allow rule carve out an exception above it", () => {
        const allow: WafCustomRule = {
            name: "uptime probe",
            enabled: true,
            action: "allow",
            conditions: [{ field: "path", operator: "equals", values: ["/healthz"] }]
        };
        const decision = evaluate(
            { wafHeader: armed([allow]), forwardedHost: "app.test", forwardedUri: "/healthz" },
            cfg
        );

        expect(decision.status).toBe(200);
    });
});
