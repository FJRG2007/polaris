/**
 * What the website-icon fetch will keep.
 *
 * The answer is served from Polaris's own origin to anybody, without a token, so
 * a site that answers its favicon with an SVG - a document that can carry
 * script - must not have it kept or served. Raster images are kept as before.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("undici", () => ({
    Agent: class {
        destroy = async () => undefined;
    },
    fetch: fetchMock
}));
vi.mock("node:dns/promises", () => ({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }]
}));

const { fetchSiteIcon } = await import("../../src/lib/vault/icons");

function answer(type: string, body: string): Response {
    return new Response(body, { status: 200, headers: { "content-type": type } });
}

beforeEach(() => {
    fetchMock.mockReset();
});

describe("fetchSiteIcon", () => {
    it("refuses an SVG favicon", async () => {
        fetchMock.mockResolvedValue(
            answer("image/svg+xml", "<svg><script>alert(1)</script></svg>")
        );
        expect(await fetchSiteIcon("svg-icon.example")).toBeNull();
    });

    it("keeps a raster favicon", async () => {
        fetchMock.mockResolvedValue(answer("image/png", "png-bytes"));
        const icon = await fetchSiteIcon("png-icon.example");
        expect(icon?.contentType).toBe("image/png");
    });
});
