/**
 * A picture from another site in a message is fetched by Polaris, never by the
 * reader's browser, and only for a signed-in caller within a budget.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    signedIn: true,
    budget: true,
    fetched: [] as string[],
    type: "image/png"
}));

vi.mock("@/lib/api-session", () => ({
    apiUser: async () =>
        state.signedIn ? { id: "u1", isAdmin: false } : new Response(null, { status: 401 })
}));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => ({ ok: state.budget, retryAfterMs: 0 })
}));
vi.mock("@/lib/safe-fetch", () => ({
    fetchImage: async (address: string) => {
        state.fetched.push(address);
        return { name: "x", contentType: state.type, bytes: new Uint8Array([1, 2, 3]) };
    }
}));

const { GET } = await import("@/app/api/media/remote-image/route");
const { remoteImageSrc } = await import("@/components/rich-text/rich-text");

const ask = (url: string) =>
    GET(new Request(`https://polaris.test/api/media/remote-image?url=${encodeURIComponent(url)}`));

beforeEach(() => {
    state.signedIn = true;
    state.budget = true;
    state.fetched = [];
    state.type = "image/png";
});

describe("remote pictures in rich text", () => {
    it("are drawn from this Polaris, not from the site", () => {
        const src = remoteImageSrc("https://tracker.example/pixel.png?who=1");
        expect(src.startsWith("/api/media/remote-image?url=")).toBe(true);
        expect(src).not.toMatch(/^https?:/);
    });

    it("are fetched server-side and served sandboxed", async () => {
        const response = await ask("https://tracker.example/pixel.png");
        expect(response.status).toBe(200);
        expect(state.fetched).toEqual(["https://tracker.example/pixel.png"]);
        expect(response.headers.get("content-security-policy")).toContain("sandbox");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("refuses a caller who is not signed in, without fetching", async () => {
        state.signedIn = false;
        expect((await ask("https://tracker.example/a.png")).status).toBe(401);
        expect(state.fetched).toEqual([]);
    });

    it("refuses past the budget, and anything that is not a web address", async () => {
        state.budget = false;
        expect((await ask("https://tracker.example/a.png")).status).toBe(429);
        state.budget = true;
        expect((await ask("javascript:alert(1)")).status).toBe(400);
        expect(state.fetched).toEqual([]);
    });

    it("never serves SVG, which is a document", async () => {
        state.type = "image/svg+xml";
        expect((await ask("https://tracker.example/a.svg")).status).toBe(404);
    });
});
