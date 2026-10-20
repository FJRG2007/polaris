/**
 * Pictures and files given to Polar: what the upload takes, who reads a file
 * back, and that a turn only ever hands a provider bytes from the person's own
 * files - never an address it would have to fetch.
 */

import type { UIMessage } from "ai";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const MINE = "0192f1a2-0000-7000-8000-000000000001";
const THEIRS = "0192f1a2-0000-7000-8000-000000000002";
const OLD = "0192f1a2-0000-7000-8000-000000000003";
const NEW = "0192f1a2-0000-7000-8000-000000000004";
const THREAD = "22222222-2222-4222-8222-222222222222";

type Row = {
    id: string;
    userId: string;
    threadId: string | null;
    name: string;
    mediaType: string;
    size: number;
    connectionId: string | null;
    path: string;
    createdAt: Date;
};

function row(id: string, extra: Partial<Row> = {}): Row {
    return {
        id,
        userId: OWNER,
        threadId: null,
        name: "cat.png",
        mediaType: "image/png",
        size: 4,
        connectionId: null,
        path: `p/${id}`,
        createdAt: new Date(),
        ...extra
    };
}

const state = {
    user: { id: OWNER, viewingAs: null as string | null } as {
        id: string;
        viewingAs: string | null;
    } | null,
    stored: [] as unknown[],
    rows: [] as Row[],
    reads: [] as string[],
    removed: [] as string[]
};

type Where = {
    id?: string | { in: string[] };
    userId?: string;
    threadId?: string | null;
    createdAt?: { lt: Date };
};

function matches(entry: Row, where: Where): boolean {
    if (typeof where.id === "string" && entry.id !== where.id) return false;
    if (where.id && typeof where.id === "object" && !where.id.in.includes(entry.id)) return false;
    if (where.userId !== undefined && entry.userId !== where.userId) return false;
    if (where.threadId !== undefined && entry.threadId !== where.threadId) return false;
    if (where.createdAt && !(entry.createdAt < where.createdAt.lt)) return false;
    return true;
}

vi.mock("@/lib/polar/access", async () =>
    (await import("./fixtures/open-polar-access")).openPolarAccess()
);
vi.mock("@/lib/api-session", () => ({
    apiUser: async () =>
        state.user
            ? { ...state.user, isAdmin: false }
            : NextResponse.json({ error: "unauthorized" }, { status: 401 })
}));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/chat/attachments", () => ({
    chatTarget: async () => "local",
    removeStoredFiles: async (files: { path: string }[]) =>
        void state.removed.push(...files.map((file) => file.path))
}));
vi.mock("@/lib/drive-stream", () => ({ pipeThenDispose: (body: ReadableStream) => body }));
vi.mock("@/lib/storage-target", () => ({
    LOCAL_TARGET: "local",
    safeName: (name: string) => name.replace(/[/\\]/g, "_"),
    streamFile: async (input: unknown) => {
        state.stored.push(input);
        return { targetId: "local", size: 4 };
    },
    driverForTarget: async () => ({
        readStream: async (path: string) => {
            state.reads.push(path);
            const size = state.rows.find((entry) => entry.path === path)?.size ?? 4;
            return new Blob([
                size === 4 ? new Uint8Array([1, 2, 3, 4]) : new Uint8Array(size)
            ]).stream();
        },
        dispose: async () => undefined
    })
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        polarAttachment: {
            create: async ({
                data
            }: {
                data: { name: string; mediaType: string; size: number };
            }) => ({
                id: MINE,
                name: data.name,
                mediaType: data.mediaType,
                size: data.size
            }),
            findFirst: async ({ where }: { where: Where }) =>
                state.rows.find((entry) => matches(entry, where)) ?? null,
            findMany: async ({ where }: { where: Where }) =>
                state.rows.filter((entry) => matches(entry, where)),
            updateMany: async ({ where, data }: { where: Where; data: Partial<Row> }) => {
                const hit = state.rows.filter((entry) => matches(entry, where));
                for (const entry of hit) Object.assign(entry, data);
                return { count: hit.length };
            },
            deleteMany: async ({ where }: { where: Where }) => {
                const before = state.rows.length;
                state.rows = state.rows.filter((entry) => !matches(entry, where));
                return { count: before - state.rows.length };
            }
        }
    }
}));

const upload = await import("../../src/app/api/polar/attachments/route");
const read = await import("../../src/app/api/polar/attachments/[id]/route");
const { inlinePolarFiles, linkPolarAttachments, sweepUnsentPolarAttachments } = await import(
    "@/lib/polar/attachments"
);

beforeEach(() => {
    state.user = { id: OWNER, viewingAs: null };
    state.stored = [];
    state.rows = [row(MINE), row(THEIRS, { userId: "33333333-3333-4333-8333-333333333333" })];
    state.reads = [];
    state.removed = [];
});

function send(type: string, bytes: Uint8Array, name = "cat.png"): Promise<Response> {
    return upload.POST(
        new Request(`https://polaris.test/api/polar/attachments?name=${encodeURIComponent(name)}`, {
            method: "POST",
            headers: { "content-type": type },
            body: bytes
        })
    );
}

const fetchFile = (id: string) =>
    read.GET(new Request(`https://polaris.test/api/polar/attachments/${id}`), {
        params: Promise.resolve({ id })
    });

const removeFile = (id: string) =>
    read.DELETE(
        new Request(`https://polaris.test/api/polar/attachments/${id}`, { method: "DELETE" }),
        {
            params: Promise.resolve({ id })
        }
    );

describe("POST /api/polar/attachments", () => {
    it("stores a picture and answers the address a message names it by", async () => {
        const answer = await send("image/png", new Uint8Array([1, 2, 3, 4]));
        expect(answer.status).toBe(200);
        expect(await answer.json()).toEqual({
            file: {
                id: MINE,
                url: `/api/polar/attachments/${MINE}`,
                filename: "cat.png",
                mediaType: "image/png",
                size: 4
            }
        });
    });

    it("refuses a kind of file Polar does not take, SVG included", async () => {
        expect((await send("image/svg+xml", new Uint8Array([1]))).status).toBe(415);
        expect((await send("text/html", new Uint8Array([1]))).status).toBe(415);
        expect(state.stored).toEqual([]);
    });

    it("refuses a file over the limit", async () => {
        expect((await send("image/png", new Uint8Array(10 * 1024 * 1024 + 1))).status).toBe(413);
    });

    it("refuses an administrator viewing as somebody else", async () => {
        state.user = { id: OWNER, viewingAs: "other" };
        expect((await send("image/png", new Uint8Array([1]))).status).toBe(403);
    });
});

describe("GET /api/polar/attachments/<id>", () => {
    it("serves the owner's picture inline, never sniffed and sandboxed", async () => {
        const answer = await fetchFile(MINE);
        expect(answer.status).toBe(200);
        expect(answer.headers.get("content-disposition")).toMatch(/^inline;/);
        expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
        expect(answer.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    });

    it("answers somebody else's file as one that does not exist", async () => {
        expect((await fetchFile(THEIRS)).status).toBe(404);
    });

    it("turns away a request with no session", async () => {
        state.user = null;
        expect((await fetchFile(MINE)).status).toBe(401);
    });
});

describe("inlinePolarFiles", () => {
    it("hands the model the owner's bytes and drops every other address", async () => {
        const messages: UIMessage[] = [
            {
                id: "u1",
                role: "user",
                parts: [
                    { type: "text", text: "look" },
                    { type: "file", mediaType: "image/png", url: `/api/polar/attachments/${MINE}` },
                    {
                        type: "file",
                        mediaType: "image/png",
                        url: `/api/polar/attachments/${THEIRS}`
                    },
                    {
                        type: "file",
                        mediaType: "image/png",
                        url: "https://169.254.169.254/latest/meta-data"
                    }
                ]
            }
        ];
        const [turn] = await inlinePolarFiles(OWNER, messages);
        expect(turn?.parts).toEqual([
            { type: "text", text: "look" },
            { type: "file", mediaType: "image/png", url: "data:image/png;base64,AQIDBA==" }
        ]);
    });

    it("spends the budget from the newest message back and never reads what does not fit", async () => {
        const big = 13 * 1024 * 1024;
        state.rows.push(row(OLD, { size: big }), row(NEW, { size: big }));
        const file = (id: string) => ({
            type: "file" as const,
            mediaType: "image/png",
            url: `/api/polar/attachments/${id}`
        });
        const messages: UIMessage[] = [
            { id: "u1", role: "user", parts: [file(OLD)] },
            { id: "a1", role: "assistant", parts: [{ type: "text", text: "seen" }] },
            { id: "u2", role: "user", parts: [{ type: "text", text: "and this" }, file(NEW)] }
        ];
        const turn = await inlinePolarFiles(OWNER, messages);
        expect(turn.map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
        expect(turn[0]?.parts).toEqual([]);
        expect(turn[2]?.parts.map((part) => part.type)).toEqual(["text", "file"]);
        expect(state.reads).toEqual([`p/${NEW}`]);
    });
});

describe("a file's lifetime", () => {
    const carrying = (id: string): UIMessage[] => [
        {
            id: "u1",
            role: "user",
            parts: [{ type: "file", mediaType: "image/png", url: `/api/polar/attachments/${id}` }]
        }
    ];

    it("belongs to the thread whose saved message carries it, and only the owner's", async () => {
        await linkPolarAttachments(OWNER, THREAD, [...carrying(MINE), ...carrying(THEIRS)]);
        expect(state.rows.find((entry) => entry.id === MINE)?.threadId).toBe(THREAD);
        expect(state.rows.find((entry) => entry.id === THEIRS)?.threadId).toBeNull();
    });

    it("can be taken back from the composer, but not once it was sent or by somebody else", async () => {
        expect((await removeFile(THEIRS)).status).toBe(404);
        await linkPolarAttachments(OWNER, THREAD, carrying(MINE));
        expect((await removeFile(MINE)).status).toBe(404);
        state.rows.push(row(NEW));
        expect((await removeFile(NEW)).status).toBe(200);
        expect(state.rows.some((entry) => entry.id === NEW)).toBe(false);
        expect(state.removed).toEqual([`p/${NEW}`]);
    });

    it("is swept a day after upload when no saved message carries it", async () => {
        const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
        state.rows = [
            row(OLD, { createdAt: old }),
            row(MINE, { createdAt: old, threadId: THREAD }),
            row(NEW)
        ];
        expect(await sweepUnsentPolarAttachments()).toEqual({ swept: 1 });
        expect(state.rows.map((entry) => entry.id)).toEqual([MINE, NEW]);
        expect(state.removed).toEqual([`p/${OLD}`]);
    });
});
