/**
 * What a device keeps of somebody's mail between visits.
 *
 * The cache exists so a mailbox paints before the network answers, the way a
 * webmail that holds everything locally does. Everything that makes it safe to
 * have is a rule about what it refuses to give back, so those are what is
 * tested: another reader's mail, a mailbox that is no longer linked, an entry
 * older than it is worth, a shape written by another build - and a ceiling on
 * how much is kept at all.
 *
 * Run over an in-memory backend: the rules are pure, and the IndexedDB adapter
 * underneath them is a thin pass-through.
 */

import { describe, expect, it } from "vitest";
import {
    MAIL_CACHE_LIMITS,
    createMailCache,
    mailCacheKey,
    mailCacheSurplus,
    type MailCacheBackend,
    type MailCacheMeta
} from "@/lib/mailbox/mail-cache";

const ANA = "018f2b7a-0000-7000-8000-0000000000a1";
const BEA = "018f2b7a-0000-7000-8000-0000000000b2";
const WORK = "018f2b7a-0000-7000-8000-0000000000c3";
const HOME = "018f2b7a-0000-7000-8000-0000000000d4";

function memoryBackend(): MailCacheBackend & { rows: Map<string, { meta: MailCacheMeta; value: unknown }> } {
    const rows = new Map<string, { meta: MailCacheMeta; value: unknown }>();
    return {
        rows,
        async readMeta() {
            return [...rows.values()].map((row) => row.meta);
        },
        async get(key) {
            return rows.get(key) ?? null;
        },
        async put(meta, value) {
            rows.set(meta.key, { meta, value });
        },
        async remove(keys) {
            for (const key of keys) rows.delete(key);
        },
        async clear() {
            rows.clear();
        }
    };
}

/** Let the fire-and-forget writes and the prune they schedule settle. */
async function settle(): Promise<void> {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

function meta(overrides: Partial<MailCacheMeta>): MailCacheMeta {
    return {
        key: overrides.key ?? Math.random().toString(36),
        owner: ANA,
        kind: "thread",
        accountId: WORK,
        at: 1_000,
        build: "b1",
        ...overrides
    };
}

describe("whose mail it gives back", () => {
    it("never answers one reader with another's", async () => {
        const backend = memoryBackend();
        const cache = createMailCache(() => backend, () => "b1");
        cache.setOwner(ANA);
        cache.write("thread", "t1", { subject: "Ana's" }, WORK);
        await settle();

        cache.setOwner(BEA);
        expect(await cache.read("thread", "t1")).toBeNull();
    });

    it("refuses an entry whose stamp is somebody else's even under the right key", async () => {
        const backend = memoryBackend();
        const cache = createMailCache(() => backend, () => "b1");
        cache.setOwner(BEA);
        const key = mailCacheKey(BEA, "thread", "t1");
        await backend.put(meta({ key, owner: ANA, at: Date.now() }), { subject: "Ana's" });
        expect(await cache.read("thread", "t1")).toBeNull();
    });

    it("deletes another reader's entries as soon as the new one is known", async () => {
        const backend = memoryBackend();
        const cache = createMailCache(() => backend, () => "b1");
        cache.setOwner(ANA);
        cache.write("message", "m1", { html: "<p>hi</p>" }, WORK);
        await settle();
        expect(backend.rows.size).toBe(1);

        cache.setOwner(BEA);
        await settle();
        expect(backend.rows.size).toBe(0);
    });

    it("answers nothing before anybody is signed in", async () => {
        const backend = memoryBackend();
        const cache = createMailCache(() => backend, () => "b1");
        cache.write("list", "inbox", { threads: [] }, "");
        await settle();
        expect(backend.rows.size).toBe(0);
        expect(await cache.read("list", "inbox")).toBeNull();
    });

    it("is emptied entirely by a sign-out", async () => {
        const backend = memoryBackend();
        const cache = createMailCache(() => backend, () => "b1");
        cache.setOwner(ANA);
        cache.write("list", "inbox", { threads: [] }, "");
        cache.write("message", "m1", { html: "" }, WORK);
        await settle();
        await cache.clear();
        expect(backend.rows.size).toBe(0);
        expect(await cache.read("list", "inbox")).toBeNull();
    });
});

describe("what it keeps", () => {
    it("gives back what it was given, for the same reader", async () => {
        const backend = memoryBackend();
        const cache = createMailCache(() => backend, () => "b1");
        cache.setOwner(ANA);
        cache.write("list", "personal.role=inbox", { threads: [{ id: "t1" }], cursor: "" }, "");
        await settle();
        expect(await cache.read("list", "personal.role=inbox")).toEqual({
            threads: [{ id: "t1" }],
            cursor: ""
        });
    });

    it("refuses what another build wrote", async () => {
        const backend = memoryBackend();
        let build = "b1";
        const cache = createMailCache(() => backend, () => build);
        cache.setOwner(ANA);
        cache.write("thread", "t1", { subject: "old shape" }, WORK);
        await settle();
        build = "b2";
        expect(await cache.read("thread", "t1")).toBeNull();
    });

    it("refuses an entry older than it is worth", async () => {
        const backend = memoryBackend();
        let now = 1_000_000;
        const cache = createMailCache(() => backend, () => "b1", () => now);
        cache.setOwner(ANA);
        cache.write("message", "m1", { html: "" }, WORK);
        await settle();
        now += MAIL_CACHE_LIMITS.message.maxAgeMs + 1;
        expect(await cache.read("message", "m1")).toBeNull();
    });

    it("refuses what came from a mailbox that is no longer linked", async () => {
        const backend = memoryBackend();
        const cache = createMailCache(() => backend, () => "b1");
        cache.setOwner(ANA);
        cache.write("thread", "t1", { subject: "work" }, WORK);
        cache.write("thread", "t2", { subject: "home" }, HOME);
        await settle();
        cache.setAccounts([HOME]);
        expect(await cache.read("thread", "t1")).toBeNull();
        expect(await cache.read("thread", "t2")).toEqual({ subject: "home" });
    });

    it("works as if nothing were kept where there is no storage at all", async () => {
        const cache = createMailCache(() => null, () => "b1");
        cache.setOwner(ANA);
        cache.write("list", "inbox", { threads: [] }, "");
        expect(await cache.read("list", "inbox")).toBeNull();
        await expect(cache.clear()).resolves.toBeUndefined();
    });

    it("answers nothing, rather than failing, when the storage does", async () => {
        const broken: MailCacheBackend = {
            readMeta: () => Promise.reject(new Error("quota")),
            get: () => Promise.reject(new Error("quota")),
            put: () => Promise.reject(new Error("quota")),
            remove: () => Promise.reject(new Error("quota")),
            clear: () => Promise.reject(new Error("quota"))
        };
        const cache = createMailCache(() => broken, () => "b1");
        cache.setOwner(ANA);
        cache.write("list", "inbox", { threads: [] }, "");
        expect(await cache.read("list", "inbox")).toBeNull();
    });
});

describe("how much it keeps", () => {
    it("drops the oldest of a kind past its ceiling and leaves the others", () => {
        const limit = MAIL_CACHE_LIMITS.thread.entries;
        const threads = Array.from({ length: limit + 3 }, (_, index) =>
            meta({ key: `t${index}`, kind: "thread", at: 10_000 + index })
        );
        const lists = [meta({ key: "l0", kind: "list", accountId: "", at: 1 })];
        const doomed = mailCacheSurplus([...threads, ...lists], ANA, null, 20_000);
        expect(doomed).toEqual(["t0", "t1", "t2"]);
    });

    it("drops anybody else's, anything too old and anything unlinked in one pass", () => {
        const now = 100 * 24 * 3_600_000;
        const doomed = mailCacheSurplus(
            [
                meta({ key: "mine", at: now - 1_000 }),
                meta({ key: "theirs", owner: BEA, at: now - 1_000 }),
                meta({ key: "stale", at: now - MAIL_CACHE_LIMITS.thread.maxAgeMs - 1 }),
                meta({ key: "unlinked", accountId: HOME, at: now - 1_000 }),
                meta({ key: "merged", kind: "list", accountId: "", at: now - 1_000 })
            ],
            ANA,
            new Set([WORK]),
            now
        );
        expect(doomed.sort()).toEqual(["stale", "theirs", "unlinked"]);
    });

    it("keeps a merged list whatever mailboxes are linked", () => {
        const doomed = mailCacheSurplus(
            [meta({ key: "merged", kind: "list", accountId: "", at: 1_000 })],
            ANA,
            new Set<string>(),
            2_000
        );
        expect(doomed).toEqual([]);
    });
});
