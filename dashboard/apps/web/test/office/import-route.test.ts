/**
 * The endpoint a file is opened through.
 *
 * What is pinned here is what the route decides rather than what the reader
 * does: that a body is bounded BEFORE it is held, because a limit checked after
 * `formData()` has already allocated everything is not a limit; and that a
 * refusal says which kind it was. A shelf somebody may not create on is a 403
 * with the reason on it - answered as a 500 it reads as "that file could not be
 * opened", which sends somebody back to a file that was never the problem.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const apiPermission = vi.fn(async () => ({ id: "u1" }) as unknown);
const createDocument = vi.fn(async () => "doc1");
const applyUpdate = vi.fn(async () => undefined);

class OfficeAccessError extends Error {
    constructor(message = "That document is not yours to open") {
        super(message);
        this.name = "OfficeAccessError";
    }
}

vi.mock("@/lib/api-session", () => ({ apiPermission }));
vi.mock("@/lib/office/documents", () => ({ applyUpdate, createDocument, OfficeAccessError }));

const route = await import("../../src/app/api/office/import/route");

const MAX_BYTES = 25 * 1024 * 1024;

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

/** One file, sent the way the screen sends it. */
function upload(name: string, text: string, orgId?: string): Request {
    const form = new FormData();
    form.set("file", new File([text], name, { type: "text/plain" }));
    if (orgId !== undefined) form.set("orgId", orgId);
    return new Request("http://localhost/api/office/import", { method: "POST", body: form });
}

describe("opening a file as a document", () => {
    beforeEach(() => {
        apiPermission.mockClear();
        createDocument.mockClear();
        applyUpdate.mockClear();
        apiPermission.mockResolvedValue({ id: "u1" });
        createDocument.mockResolvedValue("doc1");
    });

    it("opens a file inside the limit", async () => {
        const answer = await route.POST(upload("Notes.md", "# Hello\n"));
        expect(answer.status).toBe(200);
        await expect(answer.json()).resolves.toEqual({
            id: "doc1",
            kind: "doc",
            title: "Notes"
        });
        expect(applyUpdate).toHaveBeenCalledTimes(1);
    });

    it("refuses a body that says how large it is, without reading it", async () => {
        const answer = await route.POST(
            new Request("http://localhost/api/office/import", {
                method: "POST",
                body: new Uint8Array(8),
                headers: { "content-length": String(MAX_BYTES + 1) }
            })
        );
        expect(answer.status).toBe(413);
        expect(createDocument).not.toHaveBeenCalled();
    });

    it("stops reading a body that does not, rather than holding all of it first", async () => {
        const { body, pulled } = endlessBody();
        const answer = await route.POST(
            new Request("http://localhost/api/office/import", {
                method: "POST",
                body,
                ...({ duplex: "half" } as Record<string, unknown>)
            })
        );
        expect(answer.status).toBe(413);
        expect(createDocument).not.toHaveBeenCalled();
        // The limit in megabyte chunks, and a margin for the chunk that crossed
        // it and whatever the stream had buffered ahead.
        expect(pulled()).toBeLessThan(MAX_BYTES / (1024 * 1024) + 16);
    });

    it("says a shelf somebody cannot create on is refused, not unreadable", async () => {
        createDocument.mockRejectedValueOnce(
            new OfficeAccessError("That is not an organization you can create for")
        );
        const answer = await route.POST(upload("Notes.md", "# Hello\n", "org-1"));
        expect(answer.status).toBe(403);
        await expect(answer.json()).resolves.toEqual({
            error: "That is not an organization you can create for"
        });
    });

    it("says by name what it cannot read", async () => {
        const answer = await route.POST(upload("scan.pdf", "%PDF-1.4"));
        expect(answer.status).toBe(400);
        expect(createDocument).not.toHaveBeenCalled();
    });

    it("refuses a shelf id longer than one can be", async () => {
        const answer = await route.POST(upload("Notes.md", "# Hello\n", "x".repeat(65)));
        expect(answer.status).toBe(400);
        expect(createDocument).not.toHaveBeenCalled();
    });
});
