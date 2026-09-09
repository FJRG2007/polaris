/**
 * The endpoint a viewer posts a .pptx to.
 *
 * It takes bytes from anybody holding a share link and unpacks them, which makes
 * the size of what it will accept the whole of its safety: the parse is the
 * expensive part, and it happens on the machine serving everybody rather than on
 * the one that asked. So what is pinned here is that a body is bounded BEFORE it
 * is held - a limit checked after the whole request is in memory is not a limit -
 * and that each refusal says which one it was, because "too large" and "could
 * not be read" are different things to the reader and only this route knows.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const renderPptxDeck = vi.fn(async () => ({ slides: [] }));
const guardedUser = vi.fn(async () => ({ id: "u1" }) as unknown);
const gateShareRequest = vi.fn(async () => ({ ok: true }) as { ok: boolean; status?: number });

vi.mock("@/lib/session", () => ({ guardedUser }));
vi.mock("@/lib/share-access", () => ({ gateShareRequest }));
vi.mock("@/lib/office/pptx-deck", () => ({ renderPptxDeck, DEFAULT_DECK_WIDTH: 1280 }));

const route = await import("../../src/app/api/drive/slides/route");

const MOST_BYTES = 80 * 1024 * 1024;

/** A body that keeps producing megabytes, counting how many were asked for. A
 *  reader that buffers first pulls all of them; one that stops at the limit
 *  pulls just past it. */
function endlessBody(): { body: ReadableStream<Uint8Array>; pulled: () => number } {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            pulled += 1;
            controller.enqueue(new Uint8Array(1024 * 1024));
        }
    });
    return { body, pulled: () => pulled };
}

const post = (body: BodyInit | null, headers?: Record<string, string>): Request =>
    new Request("http://localhost/api/drive/slides?w=1280", {
        method: "POST",
        body,
        headers,
        // Node needs telling that a streamed body is not waiting on the answer.
        ...({ duplex: "half" } as Record<string, unknown>)
    });

describe("posting a presentation to be built", () => {
    beforeEach(() => {
        renderPptxDeck.mockClear();
        guardedUser.mockClear();
        gateShareRequest.mockClear();
        guardedUser.mockResolvedValue({ id: "u1" });
    });

    it("refuses a body that says how large it is, without reading it", async () => {
        const answer = await route.POST(
            post(new Uint8Array(8), { "content-length": String(MOST_BYTES + 1) })
        );
        expect(answer.status).toBe(413);
        await expect(answer.json()).resolves.toEqual({ error: "This presentation is too large." });
        expect(renderPptxDeck).not.toHaveBeenCalled();
    });

    it("stops reading a body that does not, rather than holding all of it first", async () => {
        const { body, pulled } = endlessBody();
        const answer = await route.POST(post(body));
        expect(answer.status).toBe(413);
        expect(renderPptxDeck).not.toHaveBeenCalled();
        // The limit in megabyte chunks, and a small margin for the chunk that
        // crossed it and whatever the stream had already buffered ahead.
        expect(pulled()).toBeLessThan(MOST_BYTES / (1024 * 1024) + 16);
    });

    it("builds a body inside the limit", async () => {
        const answer = await route.POST(post(new Uint8Array([1, 2, 3, 4])));
        expect(answer.status).toBe(200);
        expect(renderPptxDeck).toHaveBeenCalledTimes(1);
        expect([...(renderPptxDeck.mock.calls[0] as unknown as [Uint8Array, number])[0]]).toEqual([
            1, 2, 3, 4
        ]);
    });

    it("says an empty body is empty rather than unreadable", async () => {
        const answer = await route.POST(post(new Uint8Array(0)));
        expect(answer.status).toBe(400);
        await expect(answer.json()).resolves.toEqual({ error: "No presentation was sent." });
    });

    it("says a file it could not parse could not be read", async () => {
        renderPptxDeck.mockRejectedValueOnce(
            new Error("pptx: package unpacks to more than X bytes")
        );
        const answer = await route.POST(post(new Uint8Array([1, 2, 3])));
        expect(answer.status).toBe(422);
        // The reason is a detail of a file format; what leaves is a sentence.
        await expect(answer.json()).resolves.toEqual({
            error: "This presentation could not be read."
        });
    });

    it("turns away a reader who is neither signed in nor holding a share", async () => {
        guardedUser.mockResolvedValueOnce(null);
        const answer = await route.POST(post(new Uint8Array([1])));
        expect(answer.status).toBe(401);
        expect(renderPptxDeck).not.toHaveBeenCalled();
    });
});
