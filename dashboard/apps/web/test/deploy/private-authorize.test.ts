/**
 * The sign-in hop in front of a private address (`/edge/authorize`).
 *
 * The edge guard sends a visitor without a token here. What it must never do: hand a
 * token to a host Polaris does not route (an open redirect that leaks a signed token),
 * mint one for an account the address does not admit (the guard would bounce it back
 * forever), or let a token outlive the minutes it is meant to. Everything around the
 * handler - session, firewall, directory - is stood in for; the token is the real one.
 */

import { verifyEdgeToken } from "@polaris/core/waf";
import { safeRedirect } from "@/lib/safe-redirect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivateAccess } from "@/lib/deploy/private-domain";

const SECRET = "test-secret-for-the-edge-token-0123456789";

const state = vi.hoisted(() => ({
    session: null as null | { id: string; sessionId: string; sessionCreatedAt: Date },
    routed: new Set<string>(),
    privateRules: [] as { access: PrivateAccess; projectId: string }[],
    members: new Set<string>(),
    principals: [] as { principalType: string; principalId: string }[]
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_AUTH_SECRET: SECRET }) }));
vi.mock("@/lib/session", () => ({ resolveSession: async () => state.session }));
vi.mock("@/lib/session-guard", () => ({ guardSession: async () => ({ ok: true }) }));
vi.mock("@/lib/request-context", () => ({ clientIp: async () => "203.0.113.9" }));
vi.mock("@/lib/edge-signing-key", () => ({
    edgeSigningKey: async () => {
        throw new Error("no key in tests");
    }
}));
vi.mock("@polaris/auth", () => ({ principalsOfUser: async () => state.principals }));
vi.mock("@/lib/waf-service", () => ({
    resolveWaf: async () => ({ loginAllowLists: [], loginDeny: [] })
}));
vi.mock("@/lib/deploy-project-access", () => ({
    projectAccess: async (projectId: string) => (state.members.has(projectId) ? { projectId } : null)
}));
vi.mock("@/lib/deploy-service", () => ({
    deployAppIdForHost: async (host: string) => (state.routed.has(host) ? "app-1" : null),
    privateDomainsForHost: async () => state.privateRules
}));

const { GET } = await import("@/app/edge/authorize/route");

function call(redirect: string): Promise<Response> {
    return GET(
        new Request(`https://polaris.example.com/edge/authorize?redirect=${encodeURIComponent(redirect)}`)
    );
}

beforeEach(() => {
    state.session = { id: "user-ana", sessionId: "s1", sessionCreatedAt: new Date() };
    state.routed = new Set(["shop.example.com", "intranet.acme.test"]);
    state.privateRules = [{ access: { members: true, allow: [], deny: [] }, projectId: "p1" }];
    state.members = new Set(["p1"]);
    state.principals = [{ principalType: "user", principalId: "user-ana" }];
});

describe("signing in to a private address", () => {
    it("sends a visitor with no session to the Polaris sign-in, keeping the way back", async () => {
        state.session = null;
        const response = await call("https://shop.example.com/orders?id=7");
        expect(response.status).toBe(302);
        const location = response.headers.get("location") ?? "";
        expect(location.startsWith("/oauth/login?redirect=")).toBe(true);
        const back = decodeURIComponent(location.slice("/oauth/login?redirect=".length));
        expect(back).toBe(
            `/edge/authorize?redirect=${encodeURIComponent("https://shop.example.com/orders?id=7")}`
        );
        expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("refuses to send anyone, signed in or not, to a host Polaris does not route", async () => {
        for (const target of [
            "https://evil.example.net/",
            "javascript:alert(1)",
            "//shop.example.com/",
            "not a url"
        ]) {
            const response = await call(target);
            expect(response.status, target).toBe(400);
            expect(response.headers.get("location")).toBeNull();
        }
        state.session = null;
        expect((await call("https://evil.example.net/")).status).toBe(400);
    });

    it("shows a no-access page, with no token, to a signed-in account that is not allowed", async () => {
        state.members = new Set();
        const response = await call("https://shop.example.com/");
        expect(response.status).toBe(403);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(response.headers.get("location")).toBeNull();
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(await response.text()).toContain("does not have access");
    });

    it("hands an allowed member a short-lived token bound to that one host, and sets no cookie", async () => {
        const before = Math.floor(Date.now() / 1000);
        const response = await call("https://intranet.acme.test/dash");
        expect(response.status).toBe(302);
        // The Polaris session never travels: the only thing that leaves is a token in
        // the URL, which the guard on the app's own host turns into a host-only cookie.
        expect(response.headers.get("set-cookie")).toBeNull();
        const callback = new URL(response.headers.get("location") ?? "");
        expect(callback.origin).toBe("https://intranet.acme.test");
        expect(callback.pathname).toBe("/edge/callback");
        const token = callback.searchParams.get("token");
        const claims = verifyEdgeToken(token, SECRET, before, "intranet.acme.test");
        expect(claims?.sub).toBe("user-ana");
        expect(claims!.exp - before).toBeLessThanOrEqual(15 * 60 + 2);
        // Useless on any other host, tampered, or once expired.
        expect(verifyEdgeToken(token, SECRET, before, "shop.example.com")).toBeNull();
        expect(verifyEdgeToken(`${token}x`, SECRET, before, "intranet.acme.test")).toBeNull();
        expect(verifyEdgeToken(token, SECRET, claims!.exp + 1, "intranet.acme.test")).toBeNull();
        expect(verifyEdgeToken(token, "another-secret", before, "intranet.acme.test")).toBeNull();
    });

    it("admits somebody named on the address who is not a member", async () => {
        state.members = new Set();
        state.privateRules = [
            { access: { members: false, allow: [{ ref: "group:eng" }], deny: [] }, projectId: "p1" }
        ];
        state.principals.push({ principalType: "group", principalId: "eng" });
        expect((await call("https://shop.example.com/")).status).toBe(302);
    });

    it("keeps the long-lived token for an address that is not private", async () => {
        state.privateRules = [];
        state.members = new Set();
        const before = Math.floor(Date.now() / 1000);
        const response = await call("https://shop.example.com/");
        const token = new URL(response.headers.get("location") ?? "").searchParams.get("token");
        const claims = verifyEdgeToken(token, SECRET, before, "shop.example.com");
        expect(claims!.exp - before).toBeGreaterThan(60 * 60);
    });

    it("refuses somebody the address names as refused, even a member", async () => {
        state.privateRules = [
            {
                access: { members: true, allow: [], deny: [{ ref: "user:user-ana" }] },
                projectId: "p1"
            }
        ];
        const response = await call("https://shop.example.com/");
        expect(response.status).toBe(403);
        expect(await response.text()).toContain("blocked from this service");
    });

    it("asks every private rule on the host, so a public path beside a private one is no way in", async () => {
        // A member of the project behind `/`, not of the one behind `/admin`: the token
        // would be good on both paths, so it is not minted.
        state.privateRules = [
            { access: { members: true, allow: [], deny: [] }, projectId: "p1" },
            { access: { members: true, allow: [], deny: [] }, projectId: "p2" }
        ];
        expect((await call("https://shop.example.com/")).status).toBe(403);
        state.members = new Set(["p1", "p2"]);
        expect((await call("https://shop.example.com/")).status).toBe(302);
    });

    it("never carries a sign-in return trip off this origin", async () => {
        state.session = null;
        const response = await call("https://shop.example.com/a?next=//evil.example.net");
        const location = response.headers.get("location") ?? "";
        // A path on Polaris itself, which the sign-in page resolves with safeRedirect.
        expect(location.startsWith("/oauth/login?")).toBe(true);
        const back = new URL(location, "https://polaris.example.com").searchParams.get("redirect");
        expect(back?.startsWith("/edge/authorize?redirect=")).toBe(true);
        expect(safeRedirect(back)).toBe(back);
    });
});
