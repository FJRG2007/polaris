/**
 * What the chat keeps on this device: only the signed-in reader's own entries,
 * bounded by least recent use, and an unsent message that survives an update.
 */

import { describe, expect, it } from "vitest";
import {
    createLocalStore,
    localStoreSurplus,
    type LocalStoreBackend,
    type LocalStoreMeta
} from "@/lib/chat/offline/local-store";
import type { ChatMessageView } from "@/lib/chat/messages";
import { CACHED_MESSAGES_PER_CHANNEL, keptMessages } from "@/lib/chat/offline/chat-cache";

function memoryBackend() {
    const rows = new Map<string, { meta: LocalStoreMeta; value: unknown }>();
    const backend: LocalStoreBackend = {
        readMeta: async () => [...rows.values()].map((row) => row.meta),
        get: async (key) => rows.get(key) ?? null,
        put: async (meta, value) => void rows.set(meta.key, { meta, value }),
        touch: async (meta) => {
            const row = rows.get(meta.key);
            if (row) rows.set(meta.key, { ...row, meta });
        },
        remove: async (keys) => keys.forEach((key) => rows.delete(key)),
        clear: async () => rows.clear()
    };
    return { rows, backend };
}

const LIMITS = {
    messages: { entries: 2, maxAgeMs: 1_000, buildBound: true },
    outbox: { entries: 10, maxAgeMs: 1_000, buildBound: false }
};

describe("local store", () => {
    it("never answers one account with another's entries", async () => {
        const { backend } = memoryBackend();
        let clock = 0;
        const store = createLocalStore(() => backend, LIMITS, () => "b1", () => clock);
        store.setOwner("alice");
        await store.write("messages", "c1", ["hello"]);
        store.setOwner("bob");
        expect(await store.read("messages", "c1")).toBeNull();
        clock += 1;
        expect(await store.readAll("messages")).toEqual([]);
    });

    it("drops another owner's, expired and least recently used entries", () => {
        const meta = (key: string, owner: string, at: number): LocalStoreMeta => ({
            key,
            owner,
            kind: "messages",
            id: key,
            at,
            build: null
        });
        const doomed = localStoreSurplus(
            [meta("a", "me", 900), meta("b", "me", 950), meta("c", "me", 990), meta("x", "other", 990), meta("old", "me", 0)],
            "me",
            LIMITS,
            1_500
        );
        expect(doomed.sort()).toEqual(["a", "old", "x"]);
    });

    it("reads a copy from another build as nothing, but keeps the outbox across builds", async () => {
        const { backend } = memoryBackend();
        let build = "b1";
        const store = createLocalStore(() => backend, LIMITS, () => build, () => 0);
        store.setOwner("me");
        await store.write("messages", "c1", ["kept"]);
        await store.write("outbox", "k1", { body: "unsent" });
        build = "b2";
        expect(await store.read("messages", "c1")).toBeNull();
        expect(await store.readAll("outbox")).toEqual([{ id: "k1", value: { body: "unsent" } }]);
    });

    it("keeps the newest messages and none that has expired", () => {
        const message = (id: number, expiresAt?: string) => ({ id: String(id), expiresAt }) as ChatMessageView;
        const many = Array.from({ length: CACHED_MESSAGES_PER_CHANNEL + 5 }, (_, index) => message(index));
        const kept = keptMessages([...many, message(999, new Date(0).toISOString())], 10);
        expect(kept).toHaveLength(CACHED_MESSAGES_PER_CHANNEL);
        expect(kept.at(-1)?.id).toBe(String(CACHED_MESSAGES_PER_CHANNEL + 4));
    });

    it("says when nothing could be kept, so the caller sends at once instead", async () => {
        const { backend } = memoryBackend();
        const store = createLocalStore(() => backend, LIMITS, () => "b1", () => 0);
        expect(await store.write("outbox", "k1", {})).toBe(false);
        store.setOwner("me");
        expect(await store.write("outbox", "k1", {})).toBe(true);
        const missing = createLocalStore(() => null, LIMITS, () => "b1", () => 0);
        missing.setOwner("me");
        expect(await missing.write("outbox", "k1", {})).toBe(false);
        const full = createLocalStore(
            () => ({ ...backend, put: () => Promise.reject(new Error("QuotaExceededError")) }),
            LIMITS,
            () => "b1",
            () => 0
        );
        full.setOwner("me");
        expect(await full.write("outbox", "k1", {})).toBe(false);
    });
});
