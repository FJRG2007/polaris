/**
 * The sidebar's routes: a change is validated and scoped to its owner, and a
 * shared link reads only the words of a chat, read-only, and is a 404 once it
 * is revoked.
 */

import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ID = "11111111-1111-4111-8111-111111111111";
const PROJECT = "33333333-3333-4333-8333-333333333333";

const state = {
    anonymous: false,
    found: true,
    changes: [] as unknown[],
    share: null as null | { sharedAt: Date; threadId: string; thread: { title: string } },
    messages: [] as unknown[]
};

vi.mock("@/lib/api-session", () => ({
    apiUser: async () =>
        state.anonymous
            ? NextResponse.json({ error: "unauthorized" }, { status: 401 })
            : { id: "u1", name: "Ana", viewingAs: null }
}));
vi.mock("@/lib/polar/threads", () => ({
    changePolarThread: async (...args: unknown[]) => {
        state.changes.push(args);
        return state.found;
    },
    renamePolarThread: async () => state.found,
    setPolarQueue: async () => state.found,
    deletePolarThread: async () => state.found,
    getPolarThread: async () => null
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        polarThreadShare: { findUnique: async () => state.share },
        polarMessage: { findMany: async () => state.messages }
    }
}));
vi.mock("@/lib/domain-service", () => ({ sharingBaseUrl: async () => "https://polaris.example" }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k" }) }));
vi.mock("@polaris/storage", () => ({ encryptSecret: vi.fn(), decryptSecret: vi.fn() }));

const route = await import("@/app/api/polar/threads/[id]/route");
const { readSharedPolarThread } = await import("@/lib/polar/share");

const params = { params: Promise.resolve({ id: ID }) };
const patch = (body: unknown) =>
    route.PATCH(
        new Request(`http://x/api/polar/threads/${ID}`, {
            method: "PATCH",
            body: JSON.stringify(body)
        }),
        params
    );

beforeEach(() => {
    state.anonymous = false;
    state.found = true;
    state.changes = [];
    state.share = null;
    state.messages = [];
});

describe("PATCH /api/polar/threads/:id", () => {
    it("pins, archives and files a chat for its owner", async () => {
        expect((await patch({ pinned: true, archived: false, projectId: PROJECT })).status).toBe(200);
        expect(state.changes).toEqual([
            ["u1", ID, { pinned: true, archived: false, projectId: PROJECT }]
        ]);
    });

    it("takes a chat out of its project with null", async () => {
        expect((await patch({ projectId: null })).status).toBe(200);
        expect(state.changes[0]).toEqual(["u1", ID, { pinned: undefined, archived: undefined, projectId: null }]);
    });

    it("refuses a field it does not know, and an empty change", async () => {
        expect((await patch({ pinned: "yes" })).status).toBe(400);
        expect((await patch({ ownerId: "u2" })).status).toBe(400);
        expect((await patch({})).status).toBe(400);
    });

    it("answers 404 for another person's chat or project", async () => {
        state.found = false;
        expect((await patch({ projectId: PROJECT })).status).toBe(404);
    });

    it("needs a session", async () => {
        state.anonymous = true;
        expect((await patch({ pinned: true })).status).toBe(401);
    });
});

describe("a shared link", () => {
    const TOKEN = "a".repeat(43);

    it("is nothing once revoked: the row is gone", async () => {
        expect(await readSharedPolarThread(TOKEN)).toBeNull();
    });

    it("refuses a token that is not shaped like one without a lookup", async () => {
        state.share = { sharedAt: new Date(), threadId: ID, thread: { title: "T" } };
        expect(await readSharedPolarThread("../etc")).toBeNull();
    });

    it("shows the words only, never a tool call or its result", async () => {
        state.share = { sharedAt: new Date(), threadId: ID, thread: { title: "Disk" } };
        state.messages = [
            { id: "q", parentId: null, role: "user", parts: [{ type: "text", text: "How full?" }] },
            {
                id: "a",
                parentId: "q",
                role: "assistant",
                parts: [
                    { type: "tool-readDisk", output: { secret: "/srv/private" } },
                    { type: "text", text: "Half full." }
                ]
            }
        ];
        const shared = await readSharedPolarThread(TOKEN);
        expect(shared?.title).toBe("Disk");
        expect(shared?.messages).toEqual([
            { id: "q", role: "user", text: "How full?" },
            { id: "a", role: "assistant", text: "Half full." }
        ]);
        expect(JSON.stringify(shared)).not.toContain("/srv/private");
    });
});
