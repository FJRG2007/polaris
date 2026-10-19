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

const state = {
    user: { id: OWNER, viewingAs: null as string | null } as { id: string; viewingAs: string | null } | null,
    stored: [] as unknown[]
};

vi.mock("@/lib/api-session", () => ({
    apiUser: async () =>
        state.user ? { ...state.user, isAdmin: false } : NextResponse.json({ error: "unauthorized" }, { status: 401 })
}));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/chat/attachments", () => ({ chatTarget: async () => "local" }));
vi.mock("@/lib/drive-stream", () => ({ pipeThenDispose: (body: ReadableStream) => body }));
vi.mock("@/lib/storage-target", () => ({
    LOCAL_TARGET: "local",
    safeName: (name: string) => name.replace(/[/\\]/g, "_"),
    streamFile: async (input: unknown) => {
        state.stored.push(input);
        return { targetId: "local", size: 4 };
    },
    driverForTarget: async () => ({
        readStream: async () => new Blob([new Uint8Array([1, 2, 3, 4])]).stream(),
        dispose: async () => undefined
    })
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        polarAttachment: {
            create: async ({ data }: { data: { name: string; mediaType: string; size: number } }) => ({
                id: MINE,
                name: data.name,
                mediaType: data.mediaType,
                size: data.size
            }),
            // Only the owner's own row is ever found.
            findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
                where.id === MINE && where.userId === OWNER
                    ? { name: "cat.png", mediaType: "image/png", size: 4, connectionId: null, path: "p" }
                    : null
        }
    }
}));

const upload = await import("../../src/app/api/polar/attachments/route");
const read = await import("../../src/app/api/polar/attachments/[id]/route");
const { inlinePolarFiles } = await import("@/lib/polar/attachments");

beforeEach(() => {
    state.user = { id: OWNER, viewingAs: null };
    state.stored = [];
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
    read.GET(new Request(`https://polaris.test/api/polar/attachments/${id}`), { params: Promise.resolve({ id }) });

describe("POST /api/polar/attachments", () => {
    it("stores a picture and answers the address a message names it by", async () => {
        const answer = await send("image/png", new Uint8Array([1, 2, 3, 4]));
        expect(answer.status).toBe(200);
        expect(await answer.json()).toEqual({
            file: { id: MINE, url: `/api/polar/attachments/${MINE}`, filename: "cat.png", mediaType: "image/png", size: 4 }
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
                    { type: "file", mediaType: "image/png", url: `/api/polar/attachments/${THEIRS}` },
                    { type: "file", mediaType: "image/png", url: "https://169.254.169.254/latest/meta-data" }
                ]
            }
        ];
        const [turn] = await inlinePolarFiles(OWNER, messages);
        expect(turn?.parts).toEqual([
            { type: "text", text: "look" },
            { type: "file", mediaType: "image/png", url: "data:image/png;base64,AQIDBA==" }
        ]);
    });
});
