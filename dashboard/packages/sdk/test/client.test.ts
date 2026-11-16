import { describe, expect, it } from "vitest";
import { createPolarisClient, PolarisApiError } from "../src/client";
import { readSse } from "../src/sse";
import { readStreamCursor, streamCursor } from "../src/schemas";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const SESSION = {
    id: ID,
    title: "Fix the build",
    state: "working",
    repo: "acme/shop",
    branch: "polaris/fix",
    agent: "claude",
    detail: "",
    error: null,
    pullRequest: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null
};

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        }
    });
}

async function all<T>(iterable: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of iterable) out.push(item);
    return out;
}

describe("readSse", () => {
    it("parses frames split across chunks, CRLF endings, comments and ids", async () => {
        const state = { retry: null, lastId: null };
        const messages = await all(
            readSse(streamOf("retry: 3000\r\nid: 1\r\n\r\n: ping\n\nevent: ev", "ent\nid: 2\ndata: {\"a\":\ndata: 1}\n\n"), state)
        );
        expect(messages).toEqual([{ event: "event", data: "{\"a\":\n1}", id: "2" }]);
        expect(state).toEqual({ retry: 3000, lastId: "2" });
    });
});

describe("stream cursor", () => {
    it("round-trips and refuses anything else", () => {
        const cursor = { event: { at: 1700000000000, id: ID }, message: null };
        expect(readStreamCursor(streamCursor(cursor))).toEqual(cursor);
        expect(readStreamCursor("0~0")).toEqual({ event: null, message: null });
        for (const bad of ["", "0", "x~0", `1.${ID}~0~0`, `-1.${ID}~0`, "1.nope~0"])
            expect(readStreamCursor(bad)).toBeNull();
    });
});

describe("createPolarisClient", () => {
    it("sends the key, validates the body it sends and the answer it reads", async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        const client = createPolarisClient({
            baseUrl: "https://polaris.example.com/",
            token: "plk_test",
            fetch: async (url, init) => {
                calls.push({ url: String(url), init: init ?? {} });
                return Response.json({ session: SESSION, queuedAt: null });
            }
        });
        const started = await client.sessions.create({ prompt: "  fix it  ", repo: "acme/shop" });
        expect(started.session.id).toBe(ID);
        expect(calls[0]!.url).toBe("https://polaris.example.com/api/v1/sessions");
        expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer plk_test");
        expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ prompt: "fix it", agent: "claude" });
        await expect(client.sessions.create({ prompt: "" })).rejects.toThrow();
    });

    it("turns a refusal into a PolarisApiError with its sentence", async () => {
        const client = createPolarisClient({
            baseUrl: "https://p.example.com",
            token: "plk_x",
            fetch: async () => Response.json({ error: "Too many calls" }, { status: 429, headers: { "retry-after": "7" } })
        });
        const failure = await client.sessions.get(ID).catch((caught: unknown) => caught);
        expect(failure).toBeInstanceOf(PolarisApiError);
        expect(failure).toMatchObject({ status: 429, message: "Too many calls", retryAfter: 7 });
    });

    it("resumes a dropped stream with Last-Event-ID and stops at the end frame", async () => {
        const seen: (string | null)[] = [];
        let round = 0;
        const client = createPolarisClient({
            baseUrl: "https://p.example.com",
            token: "plk_x",
            fetch: async (_url, init) => {
                seen.push((init?.headers as Record<string, string>)["last-event-id"] ?? null);
                round += 1;
                const body =
                    round === 1
                        ? streamOf(`id: c1\nevent: session\ndata: ${JSON.stringify(SESSION)}\n\n`)
                        : streamOf(
                              `id: c2\nevent: event\ndata: {"id":"e","kind":"turn.end","detail":"","subject":"","at":"x"}\n\n`,
                              `id: c3\nevent: end\ndata: {"state":"stopped"}\n\n`,
                              `id: c4\nevent: session\ndata: ${JSON.stringify(SESSION)}\n\n`
                          );
                return new Response(body, { headers: { "content-type": "text/event-stream" } });
            }
        });
        const frames = await all(client.sessions.events(ID, { after: "c0" }));
        expect(frames.map((frame) => [frame.type, frame.cursor])).toEqual([
            ["session", "c1"],
            ["event", "c2"],
            ["end", "c3"]
        ]);
        expect(seen).toEqual(["c0", "c1"]);
    });

    it("does not retry a refused stream", async () => {
        let calls = 0;
        const client = createPolarisClient({
            baseUrl: "https://p.example.com",
            token: "plk_x",
            fetch: async () => {
                calls += 1;
                return Response.json({ error: "Unauthorized" }, { status: 401 });
            }
        });
        await expect(all(client.sessions.events(ID))).rejects.toMatchObject({ status: 401 });
        expect(calls).toBe(1);
    });
});
