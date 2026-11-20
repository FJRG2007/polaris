/**
 * The phone app's VPN route answers only a session that may use the VPN, and
 * hands everything else to the same client conversation the API and the
 * extension use.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const PERSON = { id: "user-1", isAdmin: false };
const apiPermission = vi.fn(async (_permission: string): Promise<unknown> => PERSON);
const rateLimit = vi.fn(async () => ({ ok: true, retryAfterMs: 0 }));
const listForClient = vi.fn(async (_userId: string) => Response.json({ nodes: [] }));
const connectForClient = vi.fn(async (_userId: string, _request: Request) =>
    Response.json({ deviceId: "d-1" })
);

vi.mock("@/lib/api-session", () => ({ apiPermission }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit }));
vi.mock("@/lib/vpn/client-route", () => ({ listForClient, connectForClient }));

const route = await import("@/app/api/mobile/vpn/route");

function connectRequest(): Request {
    return new Request("https://polaris.example.com/api/mobile/vpn", {
        method: "POST",
        body: JSON.stringify({ nodeId: "n", name: "Phone", publicKey: "k" })
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    apiPermission.mockImplementation(async () => PERSON);
    rateLimit.mockImplementation(async () => ({ ok: true, retryAfterMs: 0 }));
});

describe("the phone's VPN route", () => {
    it("lists places for a session that may use the VPN", async () => {
        const answer = await route.GET();
        expect(answer.status).toBe(200);
        expect(apiPermission).toHaveBeenCalledWith("vpn.use");
        expect(listForClient).toHaveBeenCalledWith("user-1");
    });

    it("connects as the signed-in person", async () => {
        const request = connectRequest();
        const answer = await route.POST(request);
        expect(answer.status).toBe(200);
        expect(apiPermission).toHaveBeenCalledWith("vpn.use");
        expect(connectForClient).toHaveBeenCalledWith("user-1", request);
    });

    it("refuses a session without vpn.use before anything runs", async () => {
        apiPermission.mockImplementation(async () =>
            Response.json({ error: "no" }, { status: 403 })
        );
        expect((await route.GET()).status).toBe(403);
        expect((await route.POST(connectRequest())).status).toBe(403);
        expect(listForClient).not.toHaveBeenCalled();
        expect(connectForClient).not.toHaveBeenCalled();
        expect(rateLimit).not.toHaveBeenCalled();
    });

    it("slows down a phone that keeps connecting", async () => {
        rateLimit.mockImplementation(async () => ({ ok: false, retryAfterMs: 1000 }));
        const answer = await route.POST(connectRequest());
        expect(answer.status).toBe(429);
        expect(await answer.json()).toEqual({ error: "tooMany" });
        expect(connectForClient).not.toHaveBeenCalled();
    });
});
