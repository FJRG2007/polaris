/**
 * POST /api/polar/threads/bulk: one validated, bounded request per action on a
 * selection, always scoped to the caller; and the export narrowed to a
 * selection with `?ids=`.
 */

import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PROJECT = "33333333-3333-4333-8333-333333333333";

const state = {
    anonymous: false,
    viewingAs: null as null | string,
    ownsProject: true,
    changed: [] as unknown[],
    deleted: [] as unknown[],
    stopped: [] as string[],
    exported: [] as unknown[]
};

vi.mock("@/lib/polar/access", () => ({
    polarCaller: async () =>
        state.anonymous
            ? NextResponse.json({ error: "unauthorized" }, { status: 401 })
            : { id: "u1", viewingAs: state.viewingAs }
}));
vi.mock("@/lib/polar/runs", () => ({
    stopPolarRun: (_user: string, thread: string) => void state.stopped.push(thread)
}));
vi.mock("@/lib/polar/threads", () => ({
    changePolarThreads: async (...args: unknown[]) => {
        state.changed.push(args);
        return state.ownsProject ? (args[1] as string[]).length : null;
    },
    deletePolarThreads: async (...args: unknown[]) => {
        state.deleted.push(args);
        return (args[1] as string[]).length;
    }
}));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/download-ticket", () => ({ downloadTicketHeaders: () => ({}) }));
vi.mock("@/lib/polar/export", () => ({
    exportNames: async () => ({}),
    exportAllThreads: async (...args: unknown[]) => {
        state.exported.push(args);
        return new ReadableStream();
    }
}));

const route = await import("@/app/api/polar/threads/bulk/route");
const exportRoute = await import("@/app/api/polar/export/route");
const { POLAR_BULK_MAX } = await import("@/lib/polar/shared");

const post = (body: unknown) =>
    route.POST(
        new Request("http://x/api/polar/threads/bulk", {
            method: "POST",
            body: JSON.stringify(body)
        })
    );

beforeEach(() => {
    state.anonymous = false;
    state.viewingAs = null;
    state.ownsProject = true;
    state.changed = [];
    state.deleted = [];
    state.stopped = [];
    state.exported = [];
});

describe("POST /api/polar/threads/bulk", () => {
    it("deletes the selection for its owner in one call and stops their answers", async () => {
        const response = await post({ action: "delete", ids: [id(1), id(2)] });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ count: 2 });
        expect(state.deleted).toEqual([["u1", [id(1), id(2)]]]);
        expect(state.stopped).toEqual([id(1), id(2)]);
    });

    it("files, takes out and archives in one call each", async () => {
        await post({ action: "move", ids: [id(1)], projectId: PROJECT });
        await post({ action: "move", ids: [id(1)], projectId: null });
        await post({ action: "archive", ids: [id(1), id(3)] });
        expect(state.changed).toEqual([
            ["u1", [id(1)], { kind: "move", projectId: PROJECT }],
            ["u1", [id(1)], { kind: "move", projectId: null }],
            ["u1", [id(1), id(3)], { kind: "archive" }]
        ]);
    });

    it("answers 404 for a project that is not the caller's", async () => {
        state.ownsProject = false;
        expect((await post({ action: "move", ids: [id(1)], projectId: PROJECT })).status).toBe(404);
    });

    it("refuses an unknown action, a bad id, a repeated id, a stray field and an empty list", async () => {
        for (const body of [
            { action: "pin", ids: [id(1)] },
            { action: "delete", ids: ["not-a-uuid"] },
            { action: "delete", ids: [id(1), id(1)] },
            { action: "delete", ids: [id(1)], projectId: PROJECT },
            { action: "move", ids: [id(1)] },
            { action: "delete", ids: [] },
            null
        ]) {
            expect((await post(body)).status).toBe(400);
        }
        expect(state.deleted).toEqual([]);
        expect(state.changed).toEqual([]);
    });

    it("takes at most POLAR_BULK_MAX chats", async () => {
        const most = Array.from({ length: POLAR_BULK_MAX }, (_, n) => id(n + 1));
        expect((await post({ action: "archive", ids: most })).status).toBe(200);
        expect((await post({ action: "archive", ids: [...most, id(9999)] })).status).toBe(400);
        expect(state.changed).toHaveLength(1);
    });

    it("needs a session, and changes nothing while viewing as somebody else", async () => {
        state.anonymous = true;
        expect((await post({ action: "delete", ids: [id(1)] })).status).toBe(401);
        state.anonymous = false;
        state.viewingAs = "u2";
        expect((await post({ action: "delete", ids: [id(1)] })).status).toBe(403);
        expect(state.deleted).toEqual([]);
    });
});

describe("GET /api/polar/export?ids=", () => {
    const get = (query: string) =>
        exportRoute.GET(new Request(`http://x/api/polar/export${query}`));

    it("narrows the zip to the selection", async () => {
        expect((await get(`?ids=${id(1)},${id(2)}`)).status).toBe(200);
        expect(state.exported[0]).toEqual(["u1", {}, [id(1), id(2)]]);
    });

    it("exports everything without ids, and refuses ids that are not a selection", async () => {
        await get("");
        expect(state.exported[0]).toEqual(["u1", {}, null]);
        expect((await get("?ids=nope")).status).toBe(400);
        expect((await get(`?ids=${id(1)},${id(1)}`)).status).toBe(400);
    });
});
