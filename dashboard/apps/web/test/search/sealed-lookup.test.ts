/**
 * The launcher's Chat lookup with sealed chat on: the words go to this
 * device's index, only the ids it found go to the server, a row shows the
 * words the device opened, a hit whose kept words are an older version is
 * left out, what the server says is gone leaves the index, and the rows sit
 * beside the server's within the scope's count. Off, or for a scope that
 * lists no messages, the index is never asked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { sealed: unknown[][]; forgot: string[][]; indexed: unknown[][] } = { sealed: [], forgot: [], indexed: [] };
let active = true;
let entries: { id: string; channelId: string; body: string; editedAt?: string }[] = [];
let hits: unknown[] = [];

const hit = (id: string, sealedEditedAt?: string) => ({
    message: { id, body: "", authorName: "Ana", sealed: true, ...(sealedEditedAt ? { sealedEditedAt } : {}) },
    channelId: "c1",
    channelName: "Launch",
    inSpace: false
});

vi.mock("@/app/(app)/chat/actions", () => ({
    searchSealedAction: async (query: unknown, ids: unknown, proof: unknown) => {
        calls.sealed.push([query, ids, proof]);
        return { hits, gone: ["s9"] };
    }
}));
vi.mock("@/lib/chat/e2ee/sealed-chat", () => ({
    sealedChatActive: () => active,
    searchSealedEntries: async (...args: unknown[]) => {
        calls.indexed.push(args);
        return entries;
    },
    forgetSealedText: async (ids: string[]) => void calls.forgot.push(ids)
}));

const { sealedLookupHits, withSealedHits } = await import("@/lib/search/sealed-lookup");
const words = (key: string, values?: { author: string; channel: string }) => (values ? `${key}:${values.author}:${values.channel}` : key);

beforeEach(() => {
    calls.sealed = [];
    calls.forgot = [];
    calls.indexed = [];
    active = true;
    entries = [
        { id: "s1", channelId: "c1", body: "the **launch** plan" },
        { id: "s2", channelId: "c1", body: "launch moved", editedAt: "2026-11-24T08:00:00.000Z" },
        { id: "s9", channelId: "c1", body: "launch gone" }
    ];
    hits = [hit("s1"), hit("s2", "2026-11-24T09:00:00.000Z")];
});

describe("sealed messages in the launcher", () => {
    it("finds them on this device and shows the words it opened", async () => {
        const rows = await sealedLookupHits("messages", " launch ", words);
        expect(calls.indexed).toEqual([["launch", null, 200]]);
        expect(calls.sealed).toEqual([[{ term: "launch" }, ["s1", "s2", "s9"], null]]);
        // s2 was edited after the version this device kept: left out.
        expect(rows).toEqual([
            { id: "s1", scope: "messages", label: "the launch plan", detail: "search.hits.saidIn:Ana:Launch", href: "/chat/c/c1/s1" }
        ]);
        expect(calls.forgot).toEqual([["s9"]]);
    });

    it("asks nothing with sealed chat off, nothing typed, or a scope without messages", async () => {
        active = false;
        expect(await sealedLookupHits("messages", "launch", words)).toEqual([]);
        active = true;
        expect(await sealedLookupHits("messages", "  ", words)).toEqual([]);
        expect(await sealedLookupHits("contacts", "launch", words)).toEqual([]);
        expect(await sealedLookupHits("tasks", "launch", words)).toEqual([]);
        expect(calls.indexed).toEqual([]);
        expect(calls.sealed).toEqual([]);
    });

    it("never asks the server when the device found nothing", async () => {
        entries = [];
        expect(await sealedLookupHits("chat", "launch", words)).toEqual([]);
        expect(calls.sealed).toEqual([]);
    });

    it("sits beside the server's rows, each once, within the scope's count", () => {
        const row = (id: string, scope: "messages" | "contacts" = "messages") => ({ id, scope, label: id, detail: "", href: `/${id}` });
        const found = [row("u1", "contacts"), row("m1"), row("m2"), row("m3"), row("m4")];
        const merged = withSealedHits("chat", found, [row("m2"), row("s1"), row("s2")]);
        expect(merged.map((hit) => hit.id)).toEqual(["u1", "m1", "m2", "m3", "m4", "s1"]);
        expect(withSealedHits("contacts", found, [row("s1")])).toEqual(found);
    });
});
