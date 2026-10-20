/**
 * Marks on Polar answers: a mark is saved per answer and person with the model
 * that wrote it, reasons and a note belong to a bad mark only, taking a mark
 * back deletes it, someone else's answer is a 404, and the administrator's
 * read is refused to anyone else.
 */

import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const THREAD = "22222222-2222-4222-8222-222222222222";

type Saved = { rating: string; reasons: string[]; note: string | null; model: string | null };

const state = {
    user: { id: OWNER, viewingAs: null as string | null } as {
        id: string;
        viewingAs: string | null;
    } | null,
    admin: false,
    limited: false,
    marks: new Map<string, Saved>()
};

vi.mock("@/lib/polar/access", async () =>
    (await import("./fixtures/open-polar-access")).openPolarAccess()
);
vi.mock("@/lib/api-session", () => ({
    apiUser: async () =>
        state.user
            ? { ...state.user, isAdmin: false, name: "Ada" }
            : NextResponse.json({ error: "unauthorized" }, { status: 401 })
}));
vi.mock("@/lib/session", () => ({
    backgroundUser: async () => (state.user ? { ...state.user, isAdmin: state.admin } : null)
}));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => ({ ok: !state.limited })
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        polarMessage: {
            findFirst: async ({
                where
            }: {
                where: { id: string; role: string; thread: { userId: string } };
            }) =>
                where.id === "answer" && where.thread.userId === OWNER
                    ? { metadata: { model: "gpt-test" } }
                    : null
        },
        polarAnswerFeedback: {
            upsert: async ({
                where,
                create
            }: {
                where: { userId_messageId: { messageId: string } };
                create: Saved;
            }) => {
                state.marks.set(where.userId_messageId.messageId, {
                    rating: create.rating,
                    reasons: create.reasons,
                    note: create.note,
                    model: create.model
                });
                return create;
            },
            deleteMany: async ({ where }: { where: { messageId: string } }) => {
                state.marks.delete(where.messageId);
                return { count: 1 };
            },
            findMany: async () =>
                [...state.marks].map(([messageId, mark]) => ({
                    messageId,
                    ...mark,
                    id: "f1",
                    userId: OWNER,
                    updatedAt: new Date("2026-10-20T10:00:00Z"),
                    user: { name: "Ada", email: "ada@example.test" }
                })),
            groupBy: async () => [
                { rating: "good", _count: { _all: 3 } },
                { rating: "bad", _count: { _all: 1 } }
            ]
        }
    }
}));

const feedback = await import("@/app/api/polar/feedback/route");
const admin = await import("@/app/api/admin/polar-feedback/route");

function put(body: unknown) {
    return feedback.PUT(
        new Request("http://polaris.test/api/polar/feedback", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
        })
    );
}

beforeEach(() => {
    state.user = { id: OWNER, viewingAs: null };
    state.admin = false;
    state.limited = false;
    state.marks.clear();
});

describe("PUT /api/polar/feedback", () => {
    it("saves a bad mark with its reasons, note and the answer's model", async () => {
        const response = await put({
            messageId: "answer",
            rating: "bad",
            reasons: ["incorrect", "incorrect", "style"],
            note: "  Wrong year.  "
        });
        expect(response.status).toBe(200);
        expect(state.marks.get("answer")).toEqual({
            rating: "bad",
            reasons: ["incorrect", "style"],
            note: "Wrong year.",
            model: "gpt-test"
        });
    });

    it("drops reasons and a note from a good mark", async () => {
        await put({ messageId: "answer", rating: "good", reasons: ["style"], note: "Nice" });
        expect(state.marks.get("answer")).toMatchObject({
            rating: "good",
            reasons: [],
            note: null
        });
    });

    it("takes a mark back", async () => {
        await put({ messageId: "answer", rating: "good" });
        const response = await put({ messageId: "answer", rating: null });
        expect(await response.json()).toEqual({ mark: { rating: null } });
        expect(state.marks.has("answer")).toBe(false);
    });

    it("answers someone else's answer as one that does not exist", async () => {
        expect((await put({ messageId: "elsewhere", rating: "good" })).status).toBe(404);
    });

    it("refuses an unknown reason, a bad id and a malformed body", async () => {
        expect((await put({ messageId: "answer", rating: "bad", reasons: ["x"] })).status).toBe(
            400
        );
        expect((await put({ messageId: "a b", rating: "good" })).status).toBe(400);
        expect((await put({ messageId: "answer", rating: "meh" })).status).toBe(400);
    });

    it("refuses while viewing as someone else, and when rate limited", async () => {
        state.user = { id: OWNER, viewingAs: "someone" };
        expect((await put({ messageId: "answer", rating: "good" })).status).toBe(403);
        state.user = { id: OWNER, viewingAs: null };
        state.limited = true;
        expect((await put({ messageId: "answer", rating: "good" })).status).toBe(429);
    });
});

describe("GET /api/polar/feedback", () => {
    it("reads the marks of one chat by message id", async () => {
        await put({ messageId: "answer", rating: "bad", reasons: ["slow"] });
        const response = await feedback.GET(
            new Request(`http://polaris.test/api/polar/feedback?thread=${THREAD}`)
        );
        expect(await response.json()).toEqual({
            marks: { answer: { rating: "bad", reasons: ["slow"], note: null } }
        });
    });

    it("refuses a thread that is not an id", async () => {
        const response = await feedback.GET(
            new Request("http://polaris.test/api/polar/feedback?thread=nope")
        );
        expect(response.status).toBe(400);
    });
});

describe("GET /api/admin/polar-feedback", () => {
    it("is refused to someone who is not an administrator", async () => {
        expect((await admin.GET()).status).toBe(403);
    });

    it("counts both ways and lists the bad marks without the answer", async () => {
        state.admin = true;
        await put({ messageId: "answer", rating: "bad", reasons: ["unsafe"], note: "No." });
        const body = await (await admin.GET()).json();
        expect(body.good).toBe(3);
        expect(body.bad).toBe(1);
        expect(body.recent[0]).toMatchObject({
            rating: "bad",
            reasons: ["unsafe"],
            note: "No.",
            model: "gpt-test",
            name: "Ada"
        });
        expect(JSON.stringify(body)).not.toContain("parts");
    });
});
