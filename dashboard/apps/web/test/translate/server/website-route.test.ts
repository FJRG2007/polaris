/**
 * `/api/translate/website`: signed in, the address checked, fetched only
 * through the guarded fetch, a page and nothing else, and size capped.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    user: { id: "user-1", isAdmin: false } as { id: string; isAdmin: boolean } | Response,
    allowed: true,
    rate: { ok: true },
    safeUrl: vi.fn(async (address: string) => {
        const url = new URL(address);
        return url.hostname.endsWith(".internal") ? null : url;
    }),
    follow: vi.fn(),
    readCapped: vi.fn(async (response: Response) => new Uint8Array(await response.arrayBuffer()))
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        apiSession: { apiUser: async () => mocks.user },
        session: { sessionCan: async () => mocks.allowed },
        rateLimitService: { rateLimit: async () => mocks.rate },
        i18nRequest: { getLocale: async () => "en-US" },
        safeFetch: { safeUrl: mocks.safeUrl, follow: mocks.follow, readCapped: mocks.readCapped }
    }
}));

import { POST } from "@polaris-app/translate/src/routes/api/translate/website/route";

function ask(body: unknown): Request {
    return new Request("http://localhost/api/translate/website", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
    });
}

beforeEach(() => {
    mocks.user = { id: "user-1", isAdmin: false };
    mocks.allowed = true;
    mocks.rate = { ok: true };
    mocks.follow.mockReset();
    mocks.readCapped.mockClear();
    mocks.safeUrl.mockClear();
});

describe("POST /api/translate/website", () => {
    it("answers the page's HTML, decoded in its own charset, for a normalized address", async () => {
        mocks.follow.mockResolvedValue(
            new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
                headers: { "content-type": "text/html; charset=iso-8859-1" }
            })
        );
        const response = await POST(ask({ url: " Example.com/a#frag " }));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ url: "https://example.com/a", html: "café" });
        expect(mocks.safeUrl).toHaveBeenCalledWith("https://example.com/a");
    });

    it("refuses an address that is not http(s) before fetching anything", async () => {
        expect((await POST(ask({ url: "javascript:alert(1)" }))).status).toBe(400);
        expect((await POST(ask({ url: "file:///etc/passwd" }))).status).toBe(400);
        expect((await POST(ask({}))).status).toBe(400);
        expect(mocks.follow).not.toHaveBeenCalled();
    });

    it("refuses what the guard refuses", async () => {
        expect((await POST(ask({ url: "https://db.internal/" }))).status).toBe(400);
        expect(mocks.follow).not.toHaveBeenCalled();
    });

    it("says the page could not be reached when the fetch fails or errors", async () => {
        mocks.follow.mockResolvedValueOnce(null);
        expect((await POST(ask({ url: "https://example.com" }))).status).toBe(502);
        mocks.follow.mockRejectedValueOnce(new Error("boom"));
        expect((await POST(ask({ url: "https://example.com" }))).status).toBe(502);
        mocks.follow.mockResolvedValueOnce(new Response("gone", { status: 404 }));
        expect((await POST(ask({ url: "https://example.com" }))).status).toBe(502);
    });

    it("refuses what is not a page, and a page past the cap", async () => {
        mocks.follow.mockResolvedValueOnce(
            new Response("{}", { headers: { "content-type": "application/json" } })
        );
        expect((await POST(ask({ url: "https://example.com" }))).status).toBe(415);
        mocks.follow.mockResolvedValueOnce(
            new Response("<p>x</p>", { headers: { "content-type": "text/html" } })
        );
        mocks.readCapped.mockResolvedValueOnce(null as unknown as Uint8Array);
        expect((await POST(ask({ url: "https://example.com" }))).status).toBe(413);
        expect(mocks.readCapped).toHaveBeenCalledWith(expect.anything(), 2 * 1024 * 1024);
    });

    it("refuses a caller without the permission, or over the rate", async () => {
        mocks.allowed = false;
        expect((await POST(ask({ url: "https://example.com" }))).status).toBe(403);
        mocks.allowed = true;
        mocks.rate = { ok: false };
        expect((await POST(ask({ url: "https://example.com" }))).status).toBe(429);
        expect(mocks.follow).not.toHaveBeenCalled();
    });
});
