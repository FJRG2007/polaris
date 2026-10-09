/**
 * The address an emoji's picture is served from.
 *
 * A refusal and "no such emoji" are the same 404, never cached. A picture is
 * kept by the browser for good - the bytes under an id never change - and only
 * by that browser, since whether somebody may see it is a fact about them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ID = "0193b0f0-0000-7000-8000-0000000000e1";
let reachable = true;
let asked: string[] = [];

vi.mock("@/lib/api-session", () => ({ apiUser: async () => ({ id: "ada" }) }));
vi.mock("@/lib/chat/custom-emoji", () => ({
    readSpaceEmoji: async (_actor: unknown, id: string) => {
        asked.push(id);
        return reachable ? { mime: "image/gif", bytes: new Uint8Array([71, 73, 70]) } : null;
    }
}));

const { GET } = await import("@/app/api/chat/emoji/[emojiId]/route");

const get = (emojiId: string) => GET(new Request("http://polaris.test"), { params: Promise.resolve({ emojiId }) });

beforeEach(() => {
    reachable = true;
    asked = [];
});

describe("serving an emoji", () => {
    it("answers with the picture, kept privately for good", async () => {
        const response = await get(ID);
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("image/gif");
        expect(response.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
        expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    });

    it("answers 404, uncached, to somebody outside its space", async () => {
        reachable = false;
        const response = await get(ID);
        expect(response.status).toBe(404);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    });

    it("never asks about something that is not an id", async () => {
        expect((await get("../../etc/passwd")).status).toBe(404);
        expect(asked).toEqual([]);
    });
});
