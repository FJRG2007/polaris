/**
 * GET /api/terminal/instances: the list `polaris terminal list` prints, for a key
 * holding `terminal.control` and nothing else.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let principal: { keyId: string; userId: string; scopes: string[] } | null = null;
const asked: string[] = [];

vi.mock("@/lib/api-key-auth", () => ({
    requireApiKey: async (_request: Request, required?: string) => {
        if (!principal) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (required && !principal.scopes.includes(required))
            return Response.json({ error: "forbidden", requiredScope: required }, { status: 403 });
        return principal;
    }
}));
vi.mock("@/lib/terminal/instances", () => ({
    listTerminals: async (userId: string) => {
        asked.push(userId);
        return {
            owned: [{ id: "t1", name: "desk", online: true, access: "owner" }],
            shared: [{ id: "t2", name: "lab", online: false, access: "view" }]
        };
    }
}));
vi.mock("@/lib/terminal/relay", () => ({ TERMINAL_CONTROL_SCOPE: "terminal.control" }));
vi.mock("@/lib/api-usage/recorder", () => ({ withKeyUsage: (handler: unknown) => handler }));

const route = await import("@/app/api/terminal/instances/route");
const request = () => new Request("https://polaris.example/api/terminal/instances");

beforeEach(() => {
    principal = null;
    asked.length = 0;
});

describe("GET /api/terminal/instances", () => {
    it("lists the account's own terminals and the shared ones", async () => {
        principal = { keyId: "k1", userId: "u1", scopes: ["terminal.control"] };
        const response = await route.GET(request());
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const body = (await response.json()) as { terminals: { id: string }[] };
        expect(body.terminals.map((one) => one.id)).toEqual(["t1", "t2"]);
        expect(asked).toEqual(["u1"]);
    });

    it("refuses a key without terminal.control before reading anything", async () => {
        principal = { keyId: "k1", userId: "u1", scopes: ["deploy.read"] };
        const response = await route.GET(request());
        expect(response.status).toBe(403);
        expect(asked).toEqual([]);
    });

    it("answers 401 without a key", async () => {
        expect((await route.GET(request())).status).toBe(401);
    });
});
