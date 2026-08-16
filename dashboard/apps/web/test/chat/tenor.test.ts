/**
 * The GIF/sticker picker's cache: opening the tab twice must not spend a
 * second request on the service behind it, and a real answer must still be
 * usable to send.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ fetch: 0 }));

vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_TENOR_KEY: "test-key" })
}));

vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => null,
    getIntegrationSecret: async () => null
}));

vi.mock("@/lib/safe-fetch", () => ({
    fetchImage: async () => null
}));

const originalFetch = global.fetch;

function tenorPage(ids: string[]): Response {
    calls.fetch += 1;
    return new Response(
        JSON.stringify({
            results: ids.map((id) => ({
                id,
                content_description: `gif ${id}`,
                media_formats: {
                    tinygif: { url: `https://tenor.example/${id}/tiny.gif`, dims: [100, 100] },
                    gif: { url: `https://tenor.example/${id}/full.gif` }
                }
            }))
        }),
        { status: 200, headers: { "content-type": "application/json" } }
    );
}

beforeEach(() => {
    calls.fetch = 0;
    vi.resetModules();
    global.fetch = vi.fn(async () => tenorPage(["1", "2"])) as unknown as typeof fetch;
});

afterAll(() => {
    global.fetch = originalFetch;
});

describe("the shared cache the GIF tab reads from", () => {
    it("answers the second request for the same tab from memory, not the service", async () => {
        const { searchTenor } = await import("@/lib/chat/tenor");

        const first = await searchTenor("", "gif");
        const second = await searchTenor("", "gif");

        expect(first).toHaveLength(2);
        expect(second).toEqual(first);
        expect(calls.fetch).toBe(1);
    });

    it("keeps gifs and stickers apart, and a search apart from the featured list", async () => {
        const { searchTenor } = await import("@/lib/chat/tenor");

        await searchTenor("", "gif");
        await searchTenor("", "sticker");
        await searchTenor("cat", "gif");

        expect(calls.fetch).toBe(3);
    });

    it("gives back a result shaped so the picker can send it", async () => {
        const { searchTenor } = await import("@/lib/chat/tenor");

        const [result] = await searchTenor("cat", "gif");

        expect(result).toMatchObject({
            id: "1",
            preview: "https://tenor.example/1/tiny.gif",
            full: "https://tenor.example/1/full.gif",
            description: "gif 1"
        });
    });

    it("does not remember an empty answer", async () => {
        global.fetch = vi.fn(async () => {
            calls.fetch += 1;
            return new Response(JSON.stringify({ results: [] }), {
                status: 200,
                headers: { "content-type": "application/json" }
            });
        }) as unknown as typeof fetch;
        const { searchTenor } = await import("@/lib/chat/tenor");

        await searchTenor("nothing", "gif");
        await searchTenor("nothing", "gif");

        expect(calls.fetch).toBe(2);
    });
});
