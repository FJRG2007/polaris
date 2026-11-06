/** Chat lock: the code, the guesses, the unlock proof, the hide rule, redaction. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
    lock: null as { codeHash: string; hideLocked: boolean } | null,
    locked: false,
    counts: new Map<string, number>(),
    upserts: [] as unknown[]
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_AUTH_SECRET: "test-secret" }) }));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/access", async () => {
    const actual = await vi.importActual<Record<string, unknown>>("@/lib/chat/access");
    return { ...actual, requireChannel: async () => ({}) };
});
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async (key: string, limit: number) => {
        const count = (fake.counts.get(key) ?? 0) + 1;
        fake.counts.set(key, count);
        return { ok: count <= limit };
    },
    resetRateLimit: async (key: string) => void fake.counts.delete(key)
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        chatLock: {
            findUnique: async () => fake.lock,
            deleteMany: async () => {
                fake.lock = null;
                return { count: 1 };
            },
            upsert: async (args: { update: { codeHash: string } }) => {
                fake.upserts.push(args);
                fake.lock = { codeHash: args.update.codeHash, hideLocked: false };
            }
        },
        chatChannelMember: {
            findUnique: async () => ({ locked: fake.locked }),
            updateMany: async () => {
                fake.locked = false;
                return { count: 1 };
            }
        },
        $transaction: async (steps: Promise<unknown>[]) => Promise.all(steps)
    }
}));

import * as lock from "@/lib/chat/chat-lock";
import { onShelf } from "@/app/(app)/chat/lock-shelf";

const ada = { id: "ada", name: "Ada" };
const channelId = "00000000-0000-4000-8000-000000000001";

beforeEach(async () => {
    fake.lock = { codeHash: await lock.hashLockCode("1234"), hideLocked: false };
    fake.locked = false;
    fake.counts.clear();
    fake.upserts = [];
});

describe("lock code hashing", () => {
    it("never stores the code itself, and verifies only the right one", async () => {
        const stored = await lock.hashLockCode("2468");
        expect(stored).not.toContain("2468");
        expect(await lock.lockCodeMatches("2468", stored)).toBe(true);
        expect(await lock.lockCodeMatches("2469", stored)).toBe(false);
    });

    it("refuses codes outside the allowed length", () => {
        expect(lock.lockCodeSchema.safeParse("123").success).toBe(false);
        expect(lock.lockCodeSchema.safeParse("x".repeat(65)).success).toBe(false);
        expect(lock.lockCodeSchema.safeParse(" 1234 ").success).toBe(true);
    });
});

describe("guesses", () => {
    it("stops answering after eight wrong codes, even the right one", async () => {
        for (let i = 0; i < 8; i++) expect(await lock.verifyLockCode(ada, "0000")).toBe(false);
        await expect(lock.verifyLockCode(ada, "1234")).rejects.toMatchObject({
            text: { key: "errors.lockTooMany" }
        });
    });

    it("clears the count on a right code", async () => {
        for (let i = 0; i < 7; i++) await lock.verifyLockCode(ada, "0000");
        expect(await lock.verifyLockCode(ada, "1234")).toBe(true);
        expect(await lock.verifyLockCode(ada, "0000")).toBe(false);
    });

    it("changing the code asks for the current one", async () => {
        await expect(lock.setLockCode(ada, "5678")).rejects.toMatchObject({
            text: { key: "errors.lockWrongCode" }
        });
        await expect(lock.setLockCode(ada, "5678", "0000")).rejects.toBeTruthy();
        expect(fake.upserts).toEqual([]);
        await lock.setLockCode(ada, "5678", "1234");
        expect(await lock.lockCodeMatches("5678", fake.lock!.codeHash)).toBe(true);
    });

    it("sets a first code without one to replace", async () => {
        fake.lock = null;
        await lock.setLockCode(ada, "5678");
        expect(fake.upserts).toHaveLength(1);
    });
});

describe("unlock proof", () => {
    it("opens exactly this reader's conversation until it runs out", () => {
        const now = 1_800_000_000_000;
        const hash = "hash-1";
        const proof = lock.unlockProof("ada", channelId, hash, now);
        expect(lock.readUnlockProof(proof, "ada", channelId, hash, now)).toBe(true);
        expect(lock.readUnlockProof(proof, "bob", channelId, hash, now)).toBe(false);
        expect(lock.readUnlockProof(proof, "ada", "other", hash, now)).toBe(false);
        expect(lock.readUnlockProof(proof, "ada", channelId, hash, now + 13 * 3_600_000)).toBe(
            false
        );
        expect(lock.readUnlockProof(`${proof}x`, "ada", channelId, hash, now)).toBe(false);
        expect(lock.readUnlockProof(null, "ada", channelId, hash, now)).toBe(false);
    });

    it("a new code turns away every proof handed out under the old one", async () => {
        fake.locked = true;
        const proof = await lock.unlockChannel(ada, channelId, "1234");
        await expect(lock.requireUnlocked(ada, channelId, proof)).resolves.toBeUndefined();
        await lock.setLockCode(ada, "5678", "1234");
        await expect(lock.requireUnlocked(ada, channelId, proof)).rejects.toMatchObject({
            text: { key: "errors.lockRequired" }
        });
        expect(lock.readUnlockProof(proof, "ada", channelId, null)).toBe(false);
    });

    it("refuses a locked conversation's messages without one", async () => {
        fake.locked = true;
        await expect(lock.requireUnlocked(ada, channelId, null)).rejects.toMatchObject({
            text: { key: "errors.lockRequired" }
        });
        await expect(
            lock.requireUnlocked(
                ada,
                channelId,
                lock.unlockProof("ada", channelId, fake.lock?.codeHash ?? "")
            )
        ).resolves.toBeUndefined();
        fake.locked = false;
        await expect(lock.requireUnlocked(ada, channelId, null)).resolves.toBeUndefined();
    });
});

describe("forgotten code", () => {
    it("reset takes the code and every lock away, and the guesses with them", async () => {
        fake.locked = true;
        fake.counts.set("chat-lock:ada", 8);
        await lock.resetLockCode(ada);
        expect(fake.lock).toBeNull();
        expect(fake.locked).toBe(false);
        expect(fake.counts.has("chat-lock:ada")).toBe(false);
        expect(await lock.lockState("ada")).toEqual({ hasCode: false, hideLocked: false });
        await expect(lock.requireUnlocked(ada, channelId, null)).resolves.toBeUndefined();
    });
});

describe("hidden chats", () => {
    it("a new message unhides for everybody but its author, unless muted", () => {
        const now = new Date("2026-11-06T10:00:00Z");
        expect(lock.unhideWhere(channelId, "ada", now)).toEqual({
            channelId,
            hiddenAt: { not: null },
            userId: { not: "ada" },
            OR: [{ muted: false }, { mutedUntil: { lte: now } }]
        });
        expect(lock.unhideWhere(channelId, null, now)).not.toHaveProperty("userId");
    });

    it("the list leaves out hidden chats, and locked ones when asked", () => {
        const plain = { locked: false, hidden: false };
        const hidden = { locked: false, hidden: true };
        const locked = { locked: true, hidden: false };
        expect([plain, hidden, locked].filter((c) => onShelf(c, "all", false))).toEqual([
            plain,
            locked
        ]);
        expect([plain, hidden, locked].filter((c) => onShelf(c, "all", true))).toEqual([plain]);
        expect([plain, hidden, locked].filter((c) => onShelf(c, "hidden", true))).toEqual([hidden]);
        expect([plain, hidden, locked].filter((c) => onShelf(c, "locked", false))).toEqual([
            locked
        ]);
    });
});

describe("redaction", () => {
    it("an alert about a locked chat says nothing about what or who", () => {
        const alert = {
            channelId,
            conversation: "Ada and Bob",
            authorId: "bob",
            authorName: "Bob",
            excerpt: "the secret",
            media: { kind: "image" },
            at: "now"
        };
        expect(lock.redactAlert(alert)).toEqual({
            channelId,
            conversation: "",
            authorId: null,
            authorName: "",
            excerpt: "",
            media: null,
            at: "now",
            locked: true
        });
    });
});
