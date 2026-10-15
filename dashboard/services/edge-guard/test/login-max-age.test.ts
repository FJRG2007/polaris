/**
 * A private address takes a login token only while it is young.
 *
 * The rule says how old a token may be (`loginMaxAge`); the token says when it was
 * minted (`iat`). What this pins down is the case the token's own expiry cannot: an
 * address that turns private while a visitor still holds a twelve-hour token from when
 * it only asked for a login. That token never went through the private decision, so
 * it is sent back for one - in the cookie and replayed through the callback alike -
 * and with Polaris down it is refused rather than admitted.
 */

import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { evaluate, type GuardConfig } from "../src/authz.js";
import { decodeGuardRule, encodeGuardRule, signEdgeToken } from "@polaris/core/waf";

const NOW = 1_800_000_000;
const HOST = "intranet.example.com";
const POLARIS = "https://polaris.example.com";
const SECRET = "the-shared-secret-for-tests-16+";

function config(polarisUp = true): GuardConfig {
    return {
        secret: SECRET,
        authorizeUrl: "",
        cookieName: "polaris.edge",
        now: NOW,
        controlPlane: (base) => (base === POLARIS ? polarisUp : null)
    };
}

function rule(loginMaxAge?: number): string {
    return encodeGuardRule({
        deny: [],
        requireLogin: true,
        loginUrl: POLARIS,
        loginMaxAge,
        rules: []
    });
}

function token(iat: number | undefined, aud = HOST): string {
    return signEdgeToken({ sub: "user-1", aud, exp: NOW + 12 * 3600, iat, prn: [] }, SECRET);
}

function request(wafHeader: string, options: { cookie?: string; uri?: string } = {}) {
    return {
        wafHeader,
        forwardedProto: "https",
        forwardedHost: HOST,
        forwardedUri: options.uri ?? "/reports",
        cookie: options.cookie
    };
}

describe("a route with a login max age", () => {
    it("travels in the rule and survives the round trip", () => {
        expect(decodeGuardRule(rule(900)).loginMaxAge).toBe(900);
        expect(decodeGuardRule(rule()).loginMaxAge).toBeUndefined();
        // Never written for a route that asks for no login: it would mean nothing there.
        const open = encodeGuardRule({ deny: [], requireLogin: false, loginMaxAge: 900, rules: [] });
        expect(decodeGuardRule(open).loginMaxAge).toBeUndefined();
    });

    it("admits a token minted inside the window", () => {
        const cookie = `polaris.edge=${token(NOW - 60)}`;
        expect(evaluate(request(rule(900), { cookie }), config())).toEqual({ status: 200 });
    });

    it("sends an older token, however long it has left, back to sign in", () => {
        const cookie = `polaris.edge=${token(NOW - 901)}`;
        const decision = evaluate(request(rule(900), { cookie }), config());
        expect(decision.status).toBe(302);
        expect(decision.status === 302 && decision.location).toBe(
            `${POLARIS}/edge/authorize?redirect=${encodeURIComponent(`https://${HOST}/reports`)}`
        );
        expect(decision.status === 302 && decision.setCookie).toBeFalsy();
    });

    it("treats a token that does not say when it was minted as too old", () => {
        // An HMAC token always writes `iat`; craft one without it the way an old minter did.
        const payload = Buffer.from(
            JSON.stringify({ sub: "user-1", aud: HOST, exp: NOW + 3600 })
        ).toString("base64url");
        const sig = createHmac("sha256", SECRET).update(`edge:${payload}`).digest("base64url");
        const cookie = `polaris.edge=${payload}.${sig}`;
        expect(evaluate(request(rule(900), { cookie }), config()).status).toBe(302);
        // The same token on a route with no limit is still good.
        expect(evaluate(request(rule(), { cookie }), config())).toEqual({ status: 200 });
    });

    it("will not turn an old token replayed through the callback into a cookie", () => {
        const uri = `/edge/callback?token=${token(NOW - 3600)}&redirect=${encodeURIComponent(`https://${HOST}/`)}`;
        const decision = evaluate(request(rule(900), { uri }), config());
        expect(decision.status).toBe(302);
        expect(decision.status === 302 && decision.setCookie).toBeFalsy();
        expect(decision.status === 302 && decision.location.startsWith(`${POLARIS}/edge/authorize`)).toBe(
            true
        );
    });

    it("sets a host-only, HttpOnly, Secure, SameSite cookie from a fresh callback token", () => {
        const fresh = token(NOW - 5);
        const uri = `/edge/callback?token=${fresh}&redirect=${encodeURIComponent(`https://${HOST}/reports`)}`;
        const decision = evaluate(request(rule(900), { uri }), config());
        expect(decision.status).toBe(302);
        const cookie = decision.status === 302 ? (decision.setCookie ?? "") : "";
        expect(cookie.startsWith(`polaris.edge=${fresh};`)).toBe(true);
        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("Secure");
        expect(cookie).toContain("SameSite=Lax");
        expect(cookie).not.toMatch(/Domain=/i);
    });

    it("refuses a token minted for another host", () => {
        const cookie = `polaris.edge=${token(NOW - 5, "other.example.com")}`;
        expect(evaluate(request(rule(900), { cookie }), config()).status).toBe(302);
    });

    it("fails closed while Polaris is down: an old token is refused, not admitted", () => {
        const cookie = `polaris.edge=${token(NOW - 901)}`;
        expect(evaluate(request(rule(900), { cookie }), config(false))).toEqual({
            status: 503,
            signInUnavailable: true
        });
    });
});
