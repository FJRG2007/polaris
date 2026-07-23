import { describe, it, expect } from "vitest";
import { encodeGuardRule, signEdgeToken } from "@polaris/core/waf";
import { evaluate, type GuardConfig } from "../src/authz.js";

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
        const wafHeader = encodeGuardRule({ deny: ["10.0.0.0/8"], requireLogin: false });
        expect(evaluate({ wafHeader, forwardedFor: "203.0.113.5" }, cfg)).toEqual({ status: 200 });
    });

    it("blocks an IP that matches a deny CIDR", () => {
        const wafHeader = encodeGuardRule({ deny: ["10.0.0.0/8"], requireLogin: false });
        expect(evaluate({ wafHeader, forwardedFor: "10.2.3.4" }, cfg).status).toBe(403);
    });

    it("blocks an exact deny IP", () => {
        const wafHeader = encodeGuardRule({ deny: ["203.0.113.5"], requireLogin: false });
        expect(evaluate({ wafHeader, forwardedFor: "203.0.113.5" }, cfg).status).toBe(403);
    });

    it("uses the leftmost X-Forwarded-For entry as the client IP", () => {
        const wafHeader = encodeGuardRule({ deny: ["10.0.0.0/8"], requireLogin: false });
        expect(evaluate({ wafHeader, forwardedFor: "10.2.3.4, 70.0.0.1" }, cfg).status).toBe(403);
    });

    it("fails closed when a denylist exists but the client IP is unknown", () => {
        const wafHeader = encodeGuardRule({ deny: ["10.0.0.0/8"], requireLogin: false });
        expect(evaluate({ wafHeader }, cfg).status).toBe(403);
    });
});

describe("evaluate - require login", () => {
    it("redirects to login when no token is present", () => {
        const wafHeader = encodeGuardRule({ deny: [], requireLogin: true });
        const decision = evaluate({ wafHeader, forwardedProto: "https", forwardedHost: HOST, forwardedUri: "/dash" }, cfg);
        expect(decision.status).toBe(302);
        expect(decision).toMatchObject({
            location: "https://polaris/edge/authorize?redirect=https%3A%2F%2Fapp.example.com%2Fdash"
        });
    });

    it("allows with a valid host-bound token", () => {
        const wafHeader = encodeGuardRule({ deny: [], requireLogin: true });
        const cookie = tokenCookie("user-1", HOST, NOW + 3600);
        expect(evaluate({ wafHeader, forwardedHost: HOST, cookie }, cfg)).toEqual({ status: 200 });
    });

    it("redirects when the token is bound to a different host", () => {
        const wafHeader = encodeGuardRule({ deny: [], requireLogin: true });
        const cookie = tokenCookie("user-1", "other.example.com", NOW + 3600);
        expect(evaluate({ wafHeader, forwardedHost: HOST, cookie }, cfg).status).toBe(302);
    });

    it("redirects when the token is expired", () => {
        const wafHeader = encodeGuardRule({ deny: [], requireLogin: true });
        const cookie = tokenCookie("user-1", HOST, NOW - 1);
        expect(evaluate({ wafHeader, forwardedHost: HOST, cookie }, cfg).status).toBe(302);
    });

    it("redirects when the token signature is forged", () => {
        const wafHeader = encodeGuardRule({ deny: [], requireLogin: true });
        const forged = signEdgeToken({ sub: "user-1", aud: HOST, exp: NOW + 3600 }, "wrong-secret");
        expect(evaluate({ wafHeader, forwardedHost: HOST, cookie: `polaris.edge=${forged}` }, cfg).status).toBe(302);
    });

    it("fails closed when the host is unknown", () => {
        const wafHeader = encodeGuardRule({ deny: [], requireLogin: true });
        expect(evaluate({ wafHeader }, cfg).status).toBe(403);
    });

    it("treats a malformed rule header as fail-closed (require login)", () => {
        const decision = evaluate({ wafHeader: "not-base64-json!!", forwardedHost: HOST }, cfg);
        expect(decision.status).toBe(302);
    });

    it("blocks a denied IP even when it carries a valid login token", () => {
        const wafHeader = encodeGuardRule({ deny: ["10.0.0.0/8"], requireLogin: true });
        const cookie = tokenCookie("user-1", HOST, NOW + 3600);
        expect(evaluate({ wafHeader, forwardedHost: HOST, forwardedFor: "10.9.9.9", cookie }, cfg).status).toBe(403);
    });
});

describe("evaluate - login callback", () => {
    it("sets a same-domain cookie and redirects to the original URL", () => {
        const wafHeader = encodeGuardRule({ deny: [], requireLogin: true });
        const token = signEdgeToken({ sub: "user-1", aud: HOST, exp: NOW + 3600 }, SECRET);
        const uri = `/edge/callback?token=${token}&redirect=${encodeURIComponent(`https://${HOST}/dash`)}`;
        const decision = evaluate({ wafHeader, forwardedProto: "https", forwardedHost: HOST, forwardedUri: uri }, cfg);
        expect(decision.status).toBe(302);
        expect(decision).toMatchObject({ location: `https://${HOST}/dash` });
        expect((decision as { setCookie?: string }).setCookie).toContain(`polaris.edge=${token}`);
        expect((decision as { setCookie?: string }).setCookie).toContain("Secure");
    });

    it("confines the callback redirect to the app's own host", () => {
        const wafHeader = encodeGuardRule({ deny: [], requireLogin: true });
        const token = signEdgeToken({ sub: "user-1", aud: HOST, exp: NOW + 3600 }, SECRET);
        const uri = `/edge/callback?token=${token}&redirect=${encodeURIComponent("https://evil.example.com/")}`;
        const decision = evaluate({ wafHeader, forwardedProto: "https", forwardedHost: HOST, forwardedUri: uri }, cfg);
        expect(decision).toMatchObject({ status: 302, location: `https://${HOST}/` });
    });

    it("omits Secure on a plain-http edge", () => {
        const wafHeader = encodeGuardRule({ deny: [], requireLogin: true });
        const token = signEdgeToken({ sub: "user-1", aud: HOST, exp: NOW + 3600 }, SECRET);
        const uri = `/edge/callback?token=${token}&redirect=${encodeURIComponent(`http://${HOST}/`)}`;
        const decision = evaluate({ wafHeader, forwardedProto: "http", forwardedHost: HOST, forwardedUri: uri }, cfg);
        expect((decision as { setCookie?: string }).setCookie).not.toContain("Secure");
    });

    it("redirects to login when the callback token is invalid", () => {
        const wafHeader = encodeGuardRule({ deny: [], requireLogin: true });
        const uri = `/edge/callback?token=bogus&redirect=${encodeURIComponent(`https://${HOST}/`)}`;
        const decision = evaluate({ wafHeader, forwardedProto: "https", forwardedHost: HOST, forwardedUri: uri }, cfg);
        expect(decision.status).toBe(302);
        expect(decision).toMatchObject({ location: expect.stringContaining("/edge/authorize") });
    });
});
