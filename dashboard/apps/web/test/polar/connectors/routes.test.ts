/**
 * The connector routes at their entry: who may reach them at all, ids that
 * are not the caller's, and where a sign-in callback sends the person back.
 */

import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ID = "0190a000-0000-7000-8000-000000000001";
const ELSEWHERE = "0190a000-0000-7000-8000-000000000002";

const state = vi.hoisted(() => ({
    user: null as { id: string; viewingAs: string | null } | null,
    connectors: true,
    limited: false,
    finished: [] as unknown[][],
    finishAnswer: null as string | null,
    allowed: [] as unknown[][]
}));

vi.mock("@/lib/polar/access", () => ({
    polarCaller: async () =>
        state.user
            ? { ...state.user, isAdmin: false, name: "Ada" }
            : NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    polarAccessFor: async () => ({
        use: true,
        spend: true,
        web: true,
        connectors: state.connectors
    })
}));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: !state.limited }) }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example.test" }));
vi.mock("@/lib/polar/connectors/store", () => {
    const owns = (ownerId: string, id: string) => ownerId === OWNER && id === ID;
    return {
        listConnectorViews: async () => [],
        connectorPolicy: async () => ({ who: "everyone", hosts: [], privateNetwork: false }),
        setEnabled: async (ownerId: string, id: string) => owns(ownerId, id),
        setToolPolicy: async (ownerId: string, id: string) => owns(ownerId, id),
        deleteConnector: async (ownerId: string, id: string) => owns(ownerId, id),
        ownConnector: async (ownerId: string, id: string) =>
            owns(ownerId, id) ? { row: {}, secret: null } : null,
        viewOf: () => ({ id: ID })
    };
});
vi.mock("@/lib/polar/connectors/session", () => ({
    checkConnector: async (ownerId: string, id: string) =>
        ownerId === OWNER && id === ID ? { id } : null,
    startSignIn: async (ownerId: string, id: string) =>
        ownerId === OWNER && id === ID ? { url: "https://auth.example.test" } : "not_found",
    finishSignIn: async (...args: unknown[]) => {
        state.finished.push(args);
        return state.finishAnswer;
    }
}));

vi.mock("@/lib/polar/tools", () => ({ polarCaller: async () => ({}) }));
vi.mock("@/lib/mcp/protocol", () => ({ callerMayUse: () => true }));
vi.mock("@/lib/polar/tool-grants", () => ({
    grantableTool: async () => null,
    callTarget: async () => null,
    grantScope: () => null,
    saveGrant: async () => null
}));
vi.mock("@/lib/polar/connectors/tools", () => ({
    allowConnectorTool: async (...args: unknown[]) => {
        state.allowed.push(args);
        return args[1] === "mcp_linear__create";
    }
}));

const grants = await import("@/app/api/polar/tool-grants/route");
const list = await import("@/app/api/polar/connectors/route");
const one = await import("@/app/api/polar/connectors/[id]/route");
const test = await import("@/app/api/polar/connectors/[id]/test/route");
const signIn = await import("@/app/api/polar/connectors/[id]/sign-in/route");
const callback = await import("@/app/api/polar/connectors/callback/route");

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (body: unknown) =>
    new Request("https://polaris.example.test/api/polar/connectors/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
    });
const errorOf = async (response: Response) => ((await response.json()) as { error?: string }).error;

beforeEach(() => {
    state.user = { id: OWNER, viewingAs: null };
    state.connectors = true;
    state.limited = false;
    state.finished = [];
    state.finishAnswer = null;
    state.allowed = [];
});

describe("who reaches the connector routes", () => {
    it("refuses an administrator viewing as somebody else", async () => {
        state.user = { id: OWNER, viewingAs: "22222222-2222-4222-8222-222222222222" };
        const response = await list.GET();
        expect(response.status).toBe(403);
        expect(await errorOf(response)).toBe("view_as");
    });

    it("refuses everybody when the deployment turned connectors off", async () => {
        state.connectors = false;
        for (const response of [
            await list.GET(),
            await one.DELETE(new Request("https://x.test"), params(ID)),
            await test.POST(new Request("https://x.test"), params(ID)),
            await signIn.POST(new Request("https://x.test"), params(ID))
        ]) {
            expect(response.status).toBe(403);
            expect(await errorOf(response)).toBe("connectors_off");
        }
    });

    it("answers 429 past the rate limit", async () => {
        state.limited = true;
        const response = await list.GET();
        expect(response.status).toBe(429);
        expect(await errorOf(response)).toBe("rate_limited");
    });
});

describe("a connector that is not the caller's", () => {
    it("answers 404 for an id of somebody else's or one that is not an id", async () => {
        for (const id of [ELSEWHERE, "not-an-id"]) {
            expect((await one.PATCH(patch({ enabled: false }), params(id))).status).toBe(404);
            expect(
                (await one.PATCH(patch({ tool: { name: "t", policy: "allow" } }), params(id)))
                    .status
            ).toBe(404);
            expect((await one.DELETE(new Request("https://x.test"), params(id))).status).toBe(404);
            expect((await test.POST(new Request("https://x.test"), params(id))).status).toBe(404);
            expect((await signIn.POST(new Request("https://x.test"), params(id))).status).toBe(404);
        }
    });

    it("answers the caller's own one", async () => {
        expect((await one.PATCH(patch({ enabled: false }), params(ID))).status).toBe(200);
    });
});

describe("the sign-in callback", () => {
    const back = (query: string) =>
        callback.GET(
            new Request(`https://polaris.example.test/api/polar/connectors/callback${query}`)
        );

    it("finishes only as the signed-in caller, and says how it went", async () => {
        state.finishAnswer = ID;
        const response = await back(`?state=${ID}.s&code=c`);
        expect(state.finished).toEqual([[OWNER, `${ID}.s`, "c"]]);
        expect(response.headers.get("location")).toContain("connector=signed_in");
    });

    it("sends back a failure for a state the caller never started", async () => {
        const response = await back(`?state=${ELSEWHERE}.s&code=c`);
        expect(response.headers.get("location")).toContain("connector=failed");
    });

    it("never finishes for somebody signed out or viewing as another", async () => {
        state.user = null;
        expect((await back(`?state=${ID}.s&code=c`)).headers.get("location")).toContain(
            "connector=failed"
        );
        state.user = { id: OWNER, viewingAs: "22222222-2222-4222-8222-222222222222" };
        expect((await back(`?state=${ID}.s&code=c`)).headers.get("location")).toContain(
            "connector=failed"
        );
        expect(state.finished).toEqual([]);
    });
});

describe("Always allow on a connector's tool", () => {
    const grant = (body: unknown) =>
        grants.POST(
            new Request("https://polaris.example.test/api/polar/tool-grants", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body)
            })
        );

    it("sets the caller's own tool to always allow", async () => {
        const response = await grant({ tool: "mcp_linear__create", input: {}, allow: true });
        expect(response.status).toBe(200);
        expect(state.allowed).toEqual([[OWNER, "mcp_linear__create"]]);
    });

    it("answers 404 for a connector tool the caller does not have", async () => {
        expect((await grant({ tool: "mcp_other__drop", input: {}, allow: true })).status).toBe(404);
    });

    it("stores nothing when the card only asks what a grant would cover", async () => {
        expect((await grant({ tool: "mcp_linear__create", input: {} })).status).toBe(200);
        expect(state.allowed).toEqual([]);
    });
});
