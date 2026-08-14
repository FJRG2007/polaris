/**
 * The website-icon endpoint.
 *
 * It answers without a token and answers by making a request of its own, which
 * is the combination the rest of the open routes do not have: an anonymous
 * caller naming a fresh domain each time is outbound traffic on demand. So it is
 * capped - but on the going out rather than on the answering, because a client
 * opening a vault of saved logins asks for every one of them at once and a limit
 * that counted cache hits would break the ordinary case to stop the abusive one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const cached = vi.fn();
const fetchIcon = vi.fn();
const rateLimit = vi.fn(async () => ({ ok: true }));

vi.mock("@/lib/vault/icons", () => ({ cachedSiteIcon: cached, fetchSiteIcon: fetchIcon }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit }));
vi.mock("@/lib/request-context", () => ({
    clientIp: async () => "203.0.113.7",
    hashForLog: (value: string | null) => (value ? `h(${value})` : null)
}));
vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_APP_URL: "https://polaris.test" })
}));
vi.mock("@/lib/vault/sync", () => ({ domainsResponse: () => ({}) }));
vi.mock("@/lib/vault/api/identity", () => ({ configResponse: () => ({}) }));
vi.mock("@/lib/vault/auth", () => ({
    vaultError: (message: string, status: number) =>
        Response.json({ message, object: "error" }, { status })
}));

const misc = await import("../../src/lib/vault/api/misc");

const ICON = { bytes: Buffer.from([1, 2, 3]), contentType: "image/png" };

function context(domain = "example.com") {
    return {
        request: new Request(`https://polaris.test/vault/icons/${domain}/icon.png`),
        params: { domain },
        principal: null,
        query: new URLSearchParams()
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    rateLimit.mockResolvedValue({ ok: true });
});

describe("icon", () => {
    it("serves a cached icon without spending the caller's budget", async () => {
        cached.mockReturnValue(ICON);
        const response = await misc.icon(context());
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/png");
        expect(rateLimit).not.toHaveBeenCalled();
        expect(fetchIcon).not.toHaveBeenCalled();
    });

    it("serves a remembered absence without spending it either", async () => {
        cached.mockReturnValue(null);
        expect((await misc.icon(context())).status).toBe(404);
        expect(rateLimit).not.toHaveBeenCalled();
        expect(fetchIcon).not.toHaveBeenCalled();
    });

    it("charges for a miss, because that one goes out", async () => {
        cached.mockReturnValue(undefined);
        fetchIcon.mockResolvedValue(ICON);
        expect((await misc.icon(context())).status).toBe(200);
        expect(rateLimit).toHaveBeenCalledTimes(1);
        expect(fetchIcon).toHaveBeenCalledWith("example.com");
    });

    it("turns a caller away rather than going out again once it has run out", async () => {
        cached.mockReturnValue(undefined);
        rateLimit.mockResolvedValue({ ok: false });
        const response = await misc.icon(context());
        expect(response.status).toBe(429);
        expect(fetchIcon).not.toHaveBeenCalled();
    });
});
