/**
 * A login-protected service on a server whose Polaris is unreachable.
 *
 * Everything the guard decides here it decides from what it already holds - the rule
 * on the route (with Polaris's public key), the token in the visitor's cookie, and the
 * snapshot of re-decided accounts on its own disk. What these tests pin down is the
 * outage behaviour the operator was promised: a signed-in visitor keeps access until
 * the token's hard expiry, nothing fails open, and somebody who would have to sign in
 * is told sign-in is unavailable instead of being sent to a login that does not answer.
 */

import { afterEach, describe, expect, it } from "vitest";
import { buildWafIntel, indexWafIntel } from "@polaris/core";
import { evaluate, type GuardConfig } from "../src/authz.js";
import { createControlPlaneWatch, probeHealth } from "../src/control-plane.js";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import {
    encodeGuardRule,
    signEdgeToken,
    signEdgeTokenEd25519,
    type WafPrincipalGrant
} from "@polaris/core/waf";

const NOW = 1_800_000_000;
const HOST = "app.example.com";
const POLARIS = "https://polaris.example.com";
const SECRET = "the-old-shared-secret-16+";

const { privateKey } = generateKeyPairSync("ed25519");
const PUBLIC = (createPublicKey(privateKey).export({ format: "jwk" }) as { x: string }).x;

/** The guard's config with Polaris known to be down (or up). */
function config(polarisUp: boolean, moved: Record<string, number> = {}): GuardConfig {
    return {
        secret: SECRET,
        authorizeUrl: "",
        cookieName: "polaris.edge",
        now: NOW,
        intel: indexWafIntel(buildWafIntel([], NOW * 1000, Object.entries(moved))),
        controlPlane: (base) => (base === POLARIS ? polarisUp : null)
    };
}

function rule(options: { allow?: WafPrincipalGrant[] } = {}): string {
    return encodeGuardRule({
        deny: [],
        requireLogin: true,
        loginUrl: POLARIS,
        loginAllowLists: options.allow ? [options.allow] : [],
        keys: [PUBLIC],
        rules: []
    });
}

function cookie(options: { exp?: number; iat?: number; prn?: string[] } = {}): string {
    const token = signEdgeTokenEd25519(
        {
            sub: "user-1",
            aud: HOST,
            exp: options.exp ?? NOW + 3600,
            iat: options.iat ?? NOW - 60,
            prn: options.prn ?? []
        },
        privateKey
    );
    return `polaris.edge=${token}`;
}

const request = (wafHeader: string, cookieHeader?: string) => ({
    wafHeader,
    forwardedProto: "https",
    forwardedHost: HOST,
    forwardedUri: "/dashboard",
    cookie: cookieHeader
});

describe("with Polaris unreachable", () => {
    it("lets a visitor with a valid token in, verified with the public key alone", () => {
        expect(evaluate(request(rule(), cookie()), config(false))).toEqual({ status: 200 });
    });

    it("refuses an expired token, with the sign-in-unavailable page rather than a dead redirect", () => {
        expect(evaluate(request(rule(), cookie({ exp: NOW - 1 })), config(false))).toEqual({
            status: 503,
            signInUnavailable: true
        });
    });

    it("refuses a token whose session Polaris revoked before it went away", () => {
        const revokedAt = (NOW - 10) * 1000;
        expect(
            evaluate(
                request(rule(), cookie({ iat: NOW - 60 })),
                config(false, { "user-1": revokedAt })
            )
        ).toEqual({
            status: 503,
            signInUnavailable: true
        });
    });

    it("shows a new visitor the sign-in-unavailable page", () => {
        expect(evaluate(request(rule()), config(false))).toEqual({
            status: 503,
            signInUnavailable: true
        });
    });

    it("keeps a member in past the membership backstop, up to the hard expiry", () => {
        // An hour old: past the 30-minute backstop that would normally send them to
        // Polaris for a fresher claim - which nobody can give them right now.
        const header = rule({ allow: [{ ref: "group:staff" }] });
        const stale = cookie({ iat: NOW - 3600, prn: ["group:staff"] });

        expect(evaluate(request(header, stale), config(false))).toEqual({ status: 200 });
        expect(evaluate(request(header, stale), config(true)).status).toBe(302);
    });

    it("never accepts an HMAC token on a route that carries a public key", () => {
        // The shared secret is on every server running a guard, so a token it signed
        // proves nothing to a route that can verify Polaris's own key.
        const forged = `polaris.edge=${signEdgeToken({ sub: "user-1", aud: HOST, exp: NOW + 3600, iat: NOW }, SECRET)}`;

        expect(evaluate(request(rule(), forged), config(false)).status).toBe(503);
        expect(evaluate(request(rule(), forged), config(true)).status).toBe(302);
    });

    it("refuses a token signed by any other key", () => {
        const other = generateKeyPairSync("ed25519").privateKey;
        const token = signEdgeTokenEd25519(
            { sub: "user-1", aud: HOST, exp: NOW + 3600, iat: NOW },
            other
        );

        expect(evaluate(request(rule(), `polaris.edge=${token}`), config(false)).status).toBe(503);
    });
});

describe("with Polaris answering", () => {
    it("sends a new visitor to sign in, as always", () => {
        expect(evaluate(request(rule()), config(true))).toMatchObject({ status: 302 });
    });

    it("treats a Polaris not yet probed as answering", () => {
        expect(
            evaluate(request(rule()), { ...config(true), controlPlane: () => null }).status
        ).toBe(302);
    });

    it("turns the Ed25519 token from the callback into the cookie", () => {
        const token = signEdgeTokenEd25519(
            { sub: "user-1", aud: HOST, exp: NOW + 3600, iat: NOW },
            privateKey
        );
        const decision = evaluate(
            {
                wafHeader: rule(),
                forwardedProto: "https",
                forwardedHost: HOST,
                forwardedUri: `/edge/callback?token=ignored&etoken=${encodeURIComponent(token)}&redirect=${encodeURIComponent(`https://${HOST}/x`)}`
            },
            config(true)
        );

        expect(decision).toMatchObject({ status: 302, location: `https://${HOST}/x` });
        expect(decision.status === 302 && decision.setCookie).toContain(token);
    });
});

/** Let a background probe's promise chain finish. */
const settle = () => new Promise((done) => setTimeout(done, 0));

describe("the control plane watch", () => {
    it("answers from what it last saw and probes in the background, at most once per interval", async () => {
        let calls = 0;
        let up = false;
        let clock = 0;
        const watch = createControlPlaneWatch(
            async () => {
                calls += 1;
                return up;
            },
            () => clock
        );

        expect(watch.reachable(POLARIS, 0)).toBeNull();
        await settle();
        expect(watch.reachable(POLARIS, 1000)).toBeNull();
        expect(calls).toBe(1);

        clock = 6000;
        watch.reachable(POLARIS, 6000);
        await settle();
        expect(watch.reachable(POLARIS, 6500)).toBe(false);
        expect(calls).toBe(2);

        watch.reachable(POLARIS, 12_000);
        expect(calls).toBe(2);

        up = true;
        clock = 37_000;
        watch.reachable(POLARIS, 37_000);
        await settle();
        expect(watch.reachable(POLARIS, 37_500)).toBe(true);
        expect(calls).toBe(3);
    });

    it("does not report down on a single failure after being up", async () => {
        let up = true;
        let clock = 0;
        const watch = createControlPlaneWatch(
            async () => up,
            () => clock
        );

        watch.reachable(POLARIS, 0);
        await settle();
        expect(watch.reachable(POLARIS, 100)).toBe(true);

        up = false;
        clock = 30_000;
        watch.reachable(POLARIS, 30_000);
        await settle();
        expect(watch.reachable(POLARIS, 30_100)).toBe(true);

        up = true;
        clock = 35_000;
        watch.reachable(POLARIS, 35_000);
        await settle();
        expect(watch.reachable(POLARIS, 35_100)).toBe(true);
    });

    it("counts a probe that throws as unreachable once it repeats", async () => {
        let clock = 0;
        const watch = createControlPlaneWatch(
            async () => {
                throw new Error("connection refused");
            },
            () => clock
        );

        watch.reachable(POLARIS, 0);
        await settle();
        expect(watch.reachable(POLARIS, 0)).toBeNull();
        clock = 5000;
        watch.reachable(POLARIS, 5000);
        await settle();
        expect(watch.reachable(POLARIS, 5000)).toBe(false);
    });
});

describe("the health probe", () => {
    const answering = (status: number) => async () => new Response(null, { status });
    const original = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = original;
    });

    it("counts any answer below 500 as Polaris being there", async () => {
        for (const status of [200, 301, 302, 401, 403, 404]) {
            globalThis.fetch = answering(status) as typeof fetch;
            expect(await probeHealth(POLARIS)).toBe(true);
        }
    });

    it("counts a 5xx or a refused connection as down", async () => {
        for (const status of [500, 502, 503, 504]) {
            globalThis.fetch = answering(status) as typeof fetch;
            expect(await probeHealth(POLARIS)).toBe(false);
        }
        globalThis.fetch = (async () => {
            throw new TypeError("fetch failed");
        }) as typeof fetch;
        expect(await probeHealth(POLARIS)).toBe(false);
    });
});
