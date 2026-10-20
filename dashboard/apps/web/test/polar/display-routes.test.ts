/**
 * Polar's chat display settings and a chat's own usage: defaults with no row,
 * every change validated and written for its owner only, and a chat's total
 * summed for the person who owns it and nobody else.
 */

import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const MINE = "11111111-1111-4111-8111-111111111111";
const THEIRS = "22222222-2222-4222-8222-222222222222";

const state = {
    preference: null as null | Record<string, boolean>,
    upserts: [] as { where: unknown; create: unknown; update: unknown }[],
    aggregates: [] as { where: unknown }[],
    counts: [] as { where: unknown }[]
};

vi.mock("@/lib/api-session", () => ({
    apiUser: async () => ({ id: "u1", name: "Ana", viewingAs: null })
}));
vi.mock("@/lib/polar/access", async () =>
    (await import("./fixtures/open-polar-access")).openPolarAccess()
);
vi.mock("@polaris/db", () => ({
    prisma: {
        polarPreference: {
            findUnique: async () => state.preference,
            upsert: async (args: {
                where: unknown;
                create: unknown;
                update: Record<string, boolean>;
            }) => {
                state.upserts.push(args);
                return { memory: true, ...args.update };
            }
        },
        polarThread: {
            findFirst: async (args: { where: { id: string; userId: string } }) =>
                args.where.id === MINE && args.where.userId === "u1" ? { id: MINE } : null
        },
        polarUsage: {
            aggregate: async (args: { where: unknown }) => {
                state.aggregates.push(args);
                return {
                    _count: { _all: 3 },
                    _sum: { inputTokens: 1200, outputTokens: 300, costUsd: 0.02 }
                };
            },
            count: async (args: { where: unknown }) => {
                state.counts.push(args);
                return 1;
            }
        }
    }
}));

const preferences = await import("@/app/api/polar/preferences/route");
const usage = await import("@/app/api/polar/threads/[id]/usage/route");

const patch = (body: unknown) =>
    preferences.PATCH(
        new Request("http://x", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
        })
    );
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
    state.preference = null;
    state.upserts = [];
    state.aggregates = [];
    state.counts = [];
});

describe("chat display settings", () => {
    it("are all on for a person with no row yet", async () => {
        expect(await (await preferences.GET()).json()).toEqual({
            memory: true,
            showTokens: true,
            showCost: true,
            showContextBar: true,
            autoCompact: true
        });
    });

    it("read what is stored", async () => {
        state.preference = {
            memory: false,
            showTokens: false,
            showCost: true,
            showContextBar: false,
            autoCompact: true
        };
        expect(await (await preferences.GET()).json()).toEqual(state.preference);
    });

    it("change one switch for its owner only, and answer the whole result", async () => {
        const response = await patch({ showCost: false });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ showCost: false, showTokens: true });
        expect(state.upserts).toEqual([
            {
                where: { userId: "u1" },
                create: { userId: "u1", showCost: false },
                update: { showCost: false },
                select: expect.any(Object)
            }
        ]);
    });

    it("refuse an empty change, an unknown key and a value that is not a switch", async () => {
        expect((await patch({})).status).toBe(400);
        expect((await patch({ showCost: false, theme: "dark" })).status).toBe(400);
        expect((await patch({ autoCompact: "no" })).status).toBe(400);
        expect(state.upserts).toEqual([]);
    });
});

describe("a chat's usage", () => {
    it("sums the owner's answers in that chat", async () => {
        const response = await usage.GET(new Request("http://x"), params(MINE));
        expect(await response.json()).toEqual({
            answers: 3,
            inputTokens: 1200,
            outputTokens: 300,
            costUsd: 0.02,
            unpriced: 1
        });
        expect(state.aggregates[0]?.where).toEqual({ userId: "u1", threadId: MINE });
        expect(state.counts[0]?.where).toEqual({ userId: "u1", threadId: MINE, costUsd: null });
    });

    it("is not found for somebody else's chat or a malformed id, and sums nothing", async () => {
        expect((await usage.GET(new Request("http://x"), params(THEIRS))).status).toBe(404);
        expect((await usage.GET(new Request("http://x"), params("nope"))).status).toBe(404);
        expect(state.aggregates).toEqual([]);
    });
});
