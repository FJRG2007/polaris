/**
 * Polaris Desktop answering a terminal's sign-in over its own session: only a
 * terminal's request, only for a signed-in account that is not viewing as
 * somebody else, only a JSON body - and through the approval page's own
 * service, which the screen's tests cover.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let user: Record<string, unknown> | Response = { id: "u1", isAdmin: false, sessionId: "s1" };
const described: unknown[] = [];
const answered: unknown[] = [];

vi.mock("@/lib/api-session", () => ({ apiUser: async () => user }));
vi.mock("@/lib/cli/approval", () => ({
    describeSignInFor: async (who: unknown, code: unknown, kind: unknown) => {
        described.push({ who, code, kind });
        return code === "BCDFGHJK" ? { pending: { userCode: code, device: "desk", scopes: ["polar.use"] } } : { error: "Nothing is waiting under that code." };
    },
    answerSignInFor: async (who: unknown, input: { userCode: string }) => {
        answered.push({ who, input });
        return input.userCode === "BCDFGHJK" ? { ok: true } : { error: "Nothing is waiting under that code." };
    }
}));

const describeRoute = await import("@/app/api/terminal/authorize/describe/route");
const answerRoute = await import("@/app/api/terminal/authorize/answer/route");

function post(body: unknown, type = "application/json") {
    return new Request("https://polaris.example/x", { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });
}

beforeEach(() => {
    user = { id: "u1", isAdmin: false, sessionId: "s1" };
    described.length = 0;
    answered.length = 0;
});

describe("POST /api/terminal/authorize/describe", () => {
    it("reads only a terminal's request, for the signed-in account", async () => {
        const response = await describeRoute.POST(post({ userCode: " BCDFGHJK " }));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ pending: { device: "desk" } });
        expect(described).toEqual([{ who: user, code: "BCDFGHJK", kind: "terminal" }]);
    });

    it("answers 404 for a code with nothing waiting", async () => {
        expect((await describeRoute.POST(post({ userCode: "XXXXXXXX" }))).status).toBe(404);
    });
});

describe("POST /api/terminal/authorize/answer", () => {
    it("answers as a terminal request whatever the body says", async () => {
        const response = await answerRoute.POST(post({ userCode: "BCDFGHJK", approve: true, kind: "cli" }));
        expect(response.status).toBe(200);
        expect(answered).toEqual([{ who: user, input: { userCode: "BCDFGHJK", approve: true, kind: "terminal" } }]);
    });

    it("refuses a form post, a session viewing as somebody else, a bad body and nobody", async () => {
        expect((await answerRoute.POST(post({ userCode: "BCDFGHJK", approve: true }, "text/plain"))).status).toBe(415);
        user = { id: "u1", sessionId: "s1", viewingAs: { id: "u2" } };
        expect((await answerRoute.POST(post({ userCode: "BCDFGHJK", approve: true }))).status).toBe(403);
        user = { id: "u1", sessionId: "s1" };
        expect((await answerRoute.POST(post({ userCode: "BCDFGHJK" }))).status).toBe(400);
        user = Response.json({ error: "unauthorized" }, { status: 401 });
        expect((await answerRoute.POST(post({ userCode: "BCDFGHJK", approve: true }))).status).toBe(401);
        expect(answered).toEqual([]);
    });

    it("says so when nothing was waiting", async () => {
        expect((await answerRoute.POST(post({ userCode: "XXXXXXXX", approve: false }))).status).toBe(409);
    });
});
