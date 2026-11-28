/**
 * The two routes behind "Search the web": signed-in readers only, every input
 * validated before anything upstream is asked, and each account throttled.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    user: { id: "user-1" } as { id: string } | null,
    allowed: true,
    limited: [] as string[],
    searched: [] as unknown[][],
    bytes: null as null | { name: string; type: string; bytes: Uint8Array }
}));

vi.mock("@/lib/api-session", () => ({
    apiUser: async () => state.user ?? new Response(null, { status: 401 })
}));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async (key: string) => {
        state.limited.push(key);
        return state.allowed ? { ok: true, retryAfterMs: 0 } : { ok: false, retryAfterMs: 30_000 };
    }
}));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));
vi.mock("@/lib/web-images/search", () => ({
    WebImagesUnavailable: class extends Error {},
    searchWebImages: async (...args: unknown[]) => {
        state.searched.push(args);
        return { results: [], more: false };
    },
    webImageBytes: async () => state.bytes
}));

const search = await import("@/app/api/picker/web-images/route");
const file = await import("@/app/api/picker/web-images/image/route");

beforeEach(() => {
    state.user = { id: "user-1" };
    state.allowed = true;
    state.limited = [];
    state.searched = [];
    state.bytes = null;
});

const ask = (path: string) => new Request(`https://polaris.example${path}`);

describe("the search route", () => {
    it("searches the normalized query with SafeSearch on by default", async () => {
        const answer = await search.GET(ask("/api/picker/web-images?q=%20Red%20%20Fox%20"));
        expect(answer.status).toBe(200);
        expect(state.searched).toEqual([["red fox", 1, true]]);
        expect(state.limited).toEqual(["web-images:user-1"]);
    });

    it("refuses an invalid search before it is counted or asked", async () => {
        for (const query of ["", "?q=", `?q=${"a".repeat(201)}`, "?q=cat&page=99", "?q=cat&safe=maybe"]) {
            const answer = await search.GET(ask(`/api/picker/web-images${query}`));
            expect(answer.status, query).toBe(400);
        }
        expect(state.searched).toEqual([]);
        expect(state.limited).toEqual([]);
    });

    it("answers 429 with a wait once the account has searched enough", async () => {
        state.allowed = false;
        const answer = await search.GET(ask("/api/picker/web-images?q=cat"));
        expect(answer.status).toBe(429);
        expect(answer.headers.get("retry-after")).toBe("30");
        expect(state.searched).toEqual([]);
    });

    it("answers nobody who is not signed in", async () => {
        state.user = null;
        expect((await search.GET(ask("/api/picker/web-images?q=cat"))).status).toBe(401);
    });
});

describe("the image route", () => {
    it("refuses an address in place of an id", async () => {
        const answer = await file.GET(
            ask(`/api/picker/web-images/image?id=${encodeURIComponent("https://10.0.0.1/x.png")}`)
        );
        expect(answer.status).toBe(400);
        expect(state.limited).toEqual([]);
    });

    it("serves the bytes as an inert download with their name", async () => {
        state.bytes = { name: "Red fox.png", type: "image/png", bytes: new Uint8Array([1, 2, 3]) };
        const answer = await file.GET(
            ask("/api/picker/web-images/image?id=ov:f561777d-24ea-483f-9cf8-f17aa1fd6aa3&size=full")
        );
        expect(answer.status).toBe(200);
        expect(answer.headers.get("content-type")).toBe("image/png");
        expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
        expect(answer.headers.get("content-security-policy")).toContain("sandbox");
        expect(decodeURIComponent(answer.headers.get("x-polaris-filename") ?? "")).toBe("Red fox.png");
        expect(state.limited).toEqual(["web-image-full:user-1"]);
    });

    it("answers 404 for an image that could not be fetched", async () => {
        const answer = await file.GET(ask("/api/picker/web-images/image?id=wc:42"));
        expect(answer.status).toBe(404);
    });
});
