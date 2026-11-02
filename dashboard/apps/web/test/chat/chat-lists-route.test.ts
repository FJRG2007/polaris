/**
 * The rail's lists, as a route.
 *
 * Pinned here is what moved with the read from an action: a signed-out session
 * and one without `chat.use` are refused before anything is read, and an answer
 * is never stored on the way back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const lists = { channels: [], spaces: [], categories: [], blocked: [], friends: [] };

const backgroundUser = vi.fn(async () => ({ id: "u1", name: "Ada" }) as { id: string } | null);
const sessionCan = vi.fn(async () => true);
const chatLists = vi.fn(async () => lists);

vi.mock("@/lib/session", () => ({ backgroundUser, sessionCan }));
vi.mock("@/lib/chat/chat-lists", () => ({ chatLists }));

const { GET } = await import("../../src/app/api/chat/lists/route");

beforeEach(() => vi.clearAllMocks());

describe("GET /api/chat/lists", () => {
    it("refuses a signed-out session without reading anything", async () => {
        backgroundUser.mockResolvedValueOnce(null);
        const response = await GET();
        expect(response.status).toBe(401);
        expect(chatLists).not.toHaveBeenCalled();
    });

    it("refuses a session without chat.use without reading anything", async () => {
        sessionCan.mockResolvedValueOnce(false);
        const response = await GET();
        expect(response.status).toBe(403);
        expect(sessionCan).toHaveBeenCalledWith(expect.objectContaining({ id: "u1" }), "chat.use");
        expect(chatLists).not.toHaveBeenCalled();
    });

    it("answers the reader's own lists, never to be stored", async () => {
        const response = await GET();
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(await response.json()).toEqual(lists);
        expect(chatLists).toHaveBeenCalledWith(expect.objectContaining({ id: "u1" }));
    });
});
