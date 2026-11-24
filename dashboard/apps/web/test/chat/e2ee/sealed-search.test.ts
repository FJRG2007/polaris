/**
 * The search panel's search with sealed chat on: the words go to the device's
 * index, only the ids it found go to the server, what the server says is gone
 * leaves the index, both answers come back as one list newest first, and a
 * sealed hit that no longer holds the words once opened is left out. Off, it is
 * the plain search and the index is never asked.
 */

import type { ChatSearchHit } from "@/lib/chat/search";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { plain: unknown[]; sealed: unknown[][]; forgot: string[][]; indexed: unknown[][] } = { plain: [], sealed: [], forgot: [], indexed: [] };
let active = true;
let found: string[] = [];
let opened = new Map<string, { body: string } | null>();

const hit = (id: string, createdAt: string, sealed = false): ChatSearchHit =>
    ({ message: { id, createdAt, body: "", channelId: "c", ...(sealed ? { sealed: true } : {}) }, channelId: "c", channelName: "c", inSpace: false }) as unknown as ChatSearchHit;

vi.mock("@/app/(app)/chat/actions", () => ({
    searchMessagesAction: async (query: unknown) => {
        calls.plain.push(query);
        return { hits: [hit("p1", "2026-11-24T09:00:00.000Z"), hit("p2", "2026-11-24T07:00:00.000Z")] };
    },
    searchSealedAction: async (query: unknown, ids: unknown) => {
        calls.sealed.push([query, ids]);
        return { hits: [hit("s1", "2026-11-24T08:00:00.000Z", true), hit("p1", "2026-11-24T09:00:00.000Z")], gone: ["s9"] };
    }
}));

vi.mock("@/lib/chat/e2ee/sealed-chat", () => ({
    sealedChatActive: () => active,
    searchSealedText: async (...args: unknown[]) => {
        calls.indexed.push(args);
        return found;
    },
    forgetSealedText: async (ids: string[]) => {
        calls.forgot.push(ids);
    },
    openedContent: (id: string) => opened.get(id)
}));

const { searchChat, stillMatches, mergeHits } = await import("@/app/(app)/chat/sealed-search");
const query = { term: "launch plan", channelId: null, authorId: null, has: "any", after: null, before: null };

beforeEach(() => {
    calls.plain = [];
    calls.sealed = [];
    calls.forgot = [];
    calls.indexed = [];
    active = true;
    found = ["s1", "s9"];
    opened = new Map();
});

describe("searching with sealed chat on", () => {
    it("asks the server for the device's matches by id and merges both answers newest first", async () => {
        const hits = await searchChat(query, null);
        expect(calls.indexed).toEqual([["launch plan", null, 200]]);
        expect(calls.sealed).toEqual([[expect.objectContaining({ term: "launch plan" }), ["s1", "s9"]]]);
        expect(hits.map((entry) => entry.message.id)).toEqual(["p1", "s1", "p2"]);
        expect(calls.forgot).toEqual([["s9"]]);
    });

    it("asks the server nothing more when the device found nothing", async () => {
        found = [];
        const hits = await searchChat(query, null);
        expect(calls.sealed).toEqual([]);
        expect(hits.map((entry) => entry.message.id)).toEqual(["p1", "p2"]);
    });

    it("is the plain search while sealed chat is off, or with no words", async () => {
        active = false;
        await searchChat(query, null);
        active = true;
        await searchChat({ ...query, term: "", authorId: "0190a000-0000-7000-8000-000000000001" }, null);
        expect(calls.plain).toHaveLength(2);
        expect(calls.indexed).toEqual([]);
        expect(calls.sealed).toEqual([]);
    });

    it("leaves out a sealed hit that opened to other words, and keeps one not opened yet", () => {
        const sealed = hit("s1", "2026-11-24T08:00:00.000Z", true);
        expect(stillMatches(sealed, "launch plan")).toBe(true);
        opened.set("s1", { body: "The Launch Plan, final" });
        expect(stillMatches(sealed, "launch plan")).toBe(true);
        opened.set("s1", { body: "edited away" });
        expect(stillMatches(sealed, "launch plan")).toBe(false);
        opened.set("s1", null);
        expect(stillMatches(sealed, "launch plan")).toBe(false);
        expect(stillMatches(hit("p1", "2026-11-24T09:00:00.000Z"), "launch plan")).toBe(true);
    });

    it("caps the merged list", () => {
        const many = Array.from({ length: 5 }, (_, n) => hit(`s${n}`, `2026-11-2${n}T00:00:00.000Z`, true));
        expect(mergeHits([], many, 3).map((entry) => entry.message.id)).toEqual(["s4", "s3", "s2"]);
    });
});
