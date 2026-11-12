/**
 * Looking a block page's reference up from the Firewall screen. The edge guard
 * answers; what is pinned here is how each kind of answer reads, including the
 * guard that is too old to know the question.
 */

import { wafBlockLookupToken } from "@polaris/core/waf";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_AUTH_SECRET: "shared-secret" }) }));
vi.mock("@/lib/deploy/router", () => ({ guardUrl: () => "http://guard.test:8080" }));

const { lookupWafBlock } = await import("@/lib/waf-block-lookup");

const REF = "3418858b-784f-463f-84ef-8b9013fbd592";
const BLOCK = {
    reference: REF,
    reason: "intel: ban (Exploit probing: 3 in 1m)",
    ip: "203.0.113.5",
    host: "polaris.example.com",
    uri: "/logos/apps/phpmyadmin.svg",
    method: "GET",
    userAgent: "Polaris/0.1.22",
    at: "2026-11-12T00:00:00.000Z"
};

function answer(status: number, body: string, type = "application/json") {
    const fetch = vi.fn(async () => new Response(body, { status, headers: { "content-type": type } }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("lookupWafBlock", () => {
    it("asks the guard with the shared bearer and returns the block", async () => {
        const fetch = answer(200, JSON.stringify(BLOCK));
        expect(await lookupWafBlock(REF.toUpperCase())).toEqual({ state: "found", block: BLOCK });
        const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`http://guard.test:8080/v1/blocks/${REF}`);
        expect((init.headers as Record<string, string>).authorization).toBe(
            `Bearer ${wafBlockLookupToken("shared-secret")}`
        );
    });

    it("says the guard does not hold it", async () => {
        answer(404, '{"error":"unknown","held":12}');
        expect(await lookupWafBlock(REF)).toEqual({ state: "unknown" });
    });

    it("tells a guard too old to answer from one that answered", async () => {
        answer(200, "", "text/plain");
        expect(await lookupWafBlock(REF)).toEqual({ state: "outdated" });
        answer(404, "404 page not found", "text/plain");
        expect(await lookupWafBlock(REF)).toEqual({ state: "outdated" });
    });

    it("says the guard did not answer", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
        expect(await lookupWafBlock(REF)).toEqual({ state: "unreachable" });
    });

    it("asks nothing for something that is not a reference", async () => {
        const fetch = answer(200, "{}");
        expect(await lookupWafBlock("../../etc/passwd")).toEqual({ state: "unknown" });
        expect(fetch).not.toHaveBeenCalled();
    });

    it("refuses an answer about a different reference", async () => {
        answer(200, JSON.stringify({ ...BLOCK, reference: "00000000-0000-0000-0000-000000000000" }));
        expect(await lookupWafBlock(REF)).toEqual({ state: "outdated" });
    });
});
