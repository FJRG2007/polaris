/**
 * The browser challenge at the guard: who gets the page, who gets through, and that the
 * pass a solved page leaves behind is what lets them through.
 *
 * The decision is tested on `evaluate` directly and then once through the real server,
 * because the page is what a visitor actually receives and its CSP is what lets its own
 * script run.
 */

import { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { encodeGuardRule, EDGE_PASS_COOKIE } from "@polaris/core/waf";
import { evaluate, type GuardConfig, type GuardRequest } from "../src/authz.js";
import { createGuardServer, GUARD_FEATURES, GUARD_FEATURES_HEADER } from "../src/server.js";

const cfg: GuardConfig = {
    secret: "test-secret-at-least-16-chars",
    authorizeUrl: "https://polaris",
    cookieName: "polaris.edge",
    now: 1_800_000_000,
    nonce: "fixed-nonce"
};

const HOST = "shop.example.com";
const IP = "203.0.113.9";

function request(
    rule: Parameters<typeof encodeGuardRule>[0],
    extra: Partial<GuardRequest> = {}
): GuardRequest {
    return {
        wafHeader: encodeGuardRule(rule),
        forwardedFor: IP,
        forwardedHost: HOST,
        forwardedUri: "/",
        forwardedProto: "https",
        ...extra
    };
}

const CHALLENGED = { deny: [], requireLogin: false, rules: [], challenge: true };

/** Answer a puzzle the way the page does, with Node's hash. */
function solve(challenge: string, bits: number): string {
    for (let counter = 0; ; counter += 1) {
        const digest = createHash("sha256").update(`${challenge}:${counter}`).digest();
        if (digest.readUInt32BE(0) >>> (32 - bits) === 0) return String(counter);
    }
}

describe("deciding", () => {
    it("asks a visitor with no pass to solve the page", () => {
        const decision = evaluate(request(CHALLENGED), cfg);
        expect(decision.status).toBe(503);
    });

    it("lets a visitor with a solved pass through", () => {
        const first = evaluate(request(CHALLENGED), cfg);
        if (first.status !== 503) throw new Error("expected a challenge");
        const pass = `${first.challenge}.${solve(first.challenge, first.bits)}`;
        const second = evaluate(
            request(CHALLENGED, { cookie: `${EDGE_PASS_COOKIE}=${pass}` }),
            cfg
        );
        expect(second.status).toBe(200);
    });

    it("does not accept a pass solved from another address", () => {
        const first = evaluate(request(CHALLENGED), cfg);
        if (first.status !== 503) throw new Error("expected a challenge");
        const pass = `${first.challenge}.${solve(first.challenge, first.bits)}`;
        const elsewhere = evaluate(
            request(CHALLENGED, {
                cookie: `${EDGE_PASS_COOKIE}=${pass}`,
                forwardedFor: "198.51.100.2"
            }),
            cfg
        );
        expect(elsewhere.status).toBe(503);
    });

    it("still blocks a denied address outright instead of challenging it", () => {
        const decision = evaluate(request({ ...CHALLENGED, deny: ["203.0.113.0/24"] }), cfg);
        expect(decision.status).toBe(403);
    });

    it("lets a rule step over the challenge for a path only machines call", () => {
        const decision = evaluate(
            request(
                {
                    ...CHALLENGED,
                    rules: [
                        {
                            name: "Webhooks",
                            enabled: true,
                            action: "skip",
                            skip: ["challenge"],
                            conditions: [
                                { field: "path", operator: "starts_with", values: ["/hooks"] }
                            ]
                        }
                    ]
                },
                { forwardedUri: "/hooks/github" }
            ),
            cfg
        );
        expect(decision.status).toBe(200);
    });

    it("challenges with a key of its own when no shared secret was given", () => {
        const decision = evaluate(request(CHALLENGED), {
            ...cfg,
            secret: "",
            challengeSecret: "process-key"
        });
        expect(decision.status).toBe(503);
    });
});

describe("the server", () => {
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

    it("serves the page with a CSP that lets only its own script run", async () => {
        const response = await fetch(`${guardUrl}/authz`, {
            headers: {
                "x-polaris-waf": encodeGuardRule(CHALLENGED),
                "x-forwarded-for": IP,
                "x-forwarded-host": HOST,
                "x-forwarded-proto": "https",
                accept: "text/html"
            }
        });
        const body = await response.text();
        const csp = response.headers.get("content-security-policy") ?? "";
        const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
        expect(response.status).toBe(503);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(nonce).toBeTruthy();
        expect(body).toContain(`<script nonce="${nonce}">`);
    });

    it("says what it can enforce on its health endpoint", async () => {
        const response = await fetch(`${guardUrl}/health`);
        expect(response.headers.get(GUARD_FEATURES_HEADER)).toBe(GUARD_FEATURES);
    });
});
