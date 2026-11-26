/**
 * Row 5 remainders of the migration of existing chats: a cut conversation put
 * back from its plain copies (and only the rows still the migrator's seal),
 * the copies purged after the 30-day window, and the migrated history's key
 * passed on by a member to people whose account key came after the cut.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
    migration: new Map<string, Row>(),
    messages: [] as Row[],
    edits: [] as Row[],
    copies: [] as Row[],
    historyKeys: [] as Row[],
    accountKeys: [] as Row[],
    executed: [] as unknown[][]
}));

const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, want]) => {
        if (want && typeof want === "object" && !(want instanceof Date)) {
            const w = want as { in?: unknown[]; gt?: string };
            if (w.in) return w.in.includes(row[key]);
            if (w.gt !== undefined) return String(row[key]) > w.gt;
        }
        return row[key] === want;
    });

vi.mock("@polaris/db", () => {
    const table = (rows: () => Row[]) => ({
        findMany: async ({ where, take }: { where: Row; take?: number }) => {
            const found = rows().filter((r) => matches(r, where));
            return take ? found.slice(0, take) : found;
        },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
            const hit = rows().filter((r) => matches(r, where));
            for (const r of hit) Object.assign(r, data);
            return { count: hit.length };
        },
        deleteMany: async ({ where }: { where: Row }) => {
            const all = rows();
            const kept = all.filter((r) => !matches(r, where));
            const count = all.length - kept.length;
            all.splice(0, all.length, ...kept);
            return { count };
        },
        count: async ({ where }: { where: Row }) => rows().filter((r) => matches(r, where)).length
    });
    const prisma = {
        chatMessage: table(() => db.messages),
        chatMessageEdit: table(() => db.edits),
        chatMigrationRollback: table(() => db.copies),
        chatHistoryKey: table(() => db.historyKeys),
        chatAccountKey: table(() => db.accountKeys),
        chatMigration: {
            findUnique: async ({ where }: { where: { channelId: string } }) => db.migration.get(where.channelId) ?? null,
            update: async ({ where, data }: { where: { channelId: string }; data: Row }) => Object.assign(db.migration.get(where.channelId)!, data),
            updateMany: async ({ where, data }: { where: Row; data: Row }) => {
                const row = db.migration.get(where.channelId as string);
                if (!row || row.state !== where.state) return { count: 0 };
                Object.assign(row, data);
                return { count: 1 };
            }
        },
        $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(prisma),
        $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            db.executed.push(values);
            const before = values[0] as Date;
            const limit = values[1] as number;
            const old = db.copies.filter((c) => (c.createdAt as Date) < before).slice(0, limit);
            db.copies.splice(0, db.copies.length, ...db.copies.filter((c) => !old.includes(c)));
            return old.length;
        }
    };
    return { Prisma: { DbNull: null }, prisma };
});
vi.mock("@/lib/chat/access", () => ({ conversationAudience: vi.fn() }));
// The swept reactions and votes are put back by their own module (annotation-sweep.test.ts).
const annotations = vi.hoisted(() => ({ restoreAnnotations: vi.fn(async () => ({ restored: 0, kept: 0 })) }));
vi.mock("@/lib/chat/e2ee/annotation-rollback", () => annotations);

import { MlsDevice } from "@/lib/chat/e2ee/mls-client";
import { legacyKeyGaps } from "@/lib/chat/e2ee/mls-delivery";
import * as content from "@polaris/chat-crypto/message-content";
import { accountHpkeKeyPair, accountPublicKeys, generateAccountKey } from "@polaris/chat-crypto/account-key";
import { LEGACY_EPOCH, MIGRATION_DEVICE, migrateAgain, purgeRollbackCopies, rollBackConversation } from "@/lib/chat/e2ee/legacy-migration";
import { SWEEP_EPOCH_TOP } from "@/lib/chat/e2ee/mls-history-keys";

const CHANNEL = "0192f000-0000-7000-8000-000000000001";
const NOW = new Date("2026-11-25T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const sealedColumns = { e2eeCiphertext: new Uint8Array([1]), e2eeEpoch: LEGACY_EPOCH, e2eeSenderLeaf: 0, e2eeDevice: MIGRATION_DEVICE, e2eeSignature: new Uint8Array([2]), e2eeSignatureKey: new Uint8Array([3]), e2eeRevision: null };

beforeEach(() => {
    db.migration.clear();
    for (const list of [db.messages, db.edits, db.copies, db.historyKeys, db.accountKeys, db.executed]) list.length = 0;
});

function cutConversation(cutAt = new Date(NOW.getTime() - DAY)) {
    db.migration.set(CHANNEL, { channelId: CHANNEL, state: "cut", cutAt, reason: null });
    db.messages.push({ id: "m1", channelId: CHANNEL, body: "", translation: null, ...sealedColumns }, { id: "m2", channelId: CHANNEL, body: "", translation: null, ...sealedColumns, e2eeDevice: "browser-device" });
    db.edits.push({ id: "e1", messageId: "m1", body: "", ...sealedColumns });
    db.copies.push(
        { kind: "message", id: "m1", messageId: "m1", channelId: CHANNEL, body: "hello", translation: { lang: "es" }, createdAt: cutAt },
        { kind: "edit", id: "e1", messageId: "m1", channelId: CHANNEL, body: "helo", createdAt: cutAt },
        { kind: "message", id: "m2", messageId: "m2", channelId: CHANNEL, body: "old words", translation: null, createdAt: cutAt }
    );
    db.historyKeys.push({ channelId: CHANNEL, epoch: LEGACY_EPOCH, recipient: "u1", envelope: new Uint8Array([9]) });
}

describe("rolling a migrated conversation back", () => {
    it("restores the migrator's rows and their edits, keeps a message edited sealed since, and stops the migrator taking it", async () => {
        cutConversation();
        await expect(rollBackConversation(CHANNEL, NOW)).resolves.toEqual({ restored: 1, kept: 1 });
        expect(db.messages[0]).toMatchObject({ body: "hello", translation: { lang: "es" }, e2eeCiphertext: null, e2eeDevice: null });
        expect(db.edits[0]).toMatchObject({ body: "helo", e2eeCiphertext: null, e2eeDevice: null });
        // Edited sealed after the cut: its copy is no longer what it says, so it keeps its seal.
        expect(db.messages[1]).toMatchObject({ body: "", e2eeDevice: "browser-device" });
        expect(db.copies.map((c) => c.id)).toEqual(["m2"]);
        expect(db.migration.get(CHANNEL)).toMatchObject({ state: "rolledBack", reason: "keptEdited" });
        // No row is the migrator's seal any more: the legacy key envelopes go.
        expect(db.historyKeys).toHaveLength(0);
    });

    it("leaves a restored message's swept reaction copies to the annotation restore, and runs it", async () => {
        cutConversation();
        db.copies.push({ kind: "reaction", id: "r1", messageId: "m1", channelId: CHANNEL, body: "{}", createdAt: NOW });
        await rollBackConversation(CHANNEL, NOW);
        expect(db.copies.map((c) => c.id)).toEqual(["m2", "r1"]);
        expect(annotations.restoreAnnotations).toHaveBeenCalledWith(CHANNEL);
    });

    it("keeps the legacy key while a migrated row is still sealed under it", async () => {
        cutConversation();
        db.messages.push({ id: "m3", channelId: CHANNEL, body: "", ...sealedColumns });
        await rollBackConversation(CHANNEL, NOW);
        expect(db.historyKeys).toHaveLength(1);
    });

    it("refuses one that is not cut, or whose 30 days are over", async () => {
        await expect(rollBackConversation(CHANNEL, NOW)).resolves.toBe("notCut");
        cutConversation(new Date(NOW.getTime() - 31 * DAY));
        await expect(rollBackConversation(CHANNEL, NOW)).resolves.toBe("expired");
        expect(db.messages[0]).toMatchObject({ body: "" });
    });

    it("is repeatable: a second run after the first changes nothing", async () => {
        cutConversation();
        await rollBackConversation(CHANNEL, NOW);
        await expect(rollBackConversation(CHANNEL, NOW)).resolves.toBe("notCut");
    });

    it("hands a rolled-back conversation to the migrator again only from rolledBack", async () => {
        cutConversation();
        await expect(migrateAgain(CHANNEL)).resolves.toBe(false);
        await rollBackConversation(CHANNEL, NOW);
        await expect(migrateAgain(CHANNEL)).resolves.toBe(true);
        expect(db.migration.get(CHANNEL)).toMatchObject({ state: "pending", cutAt: null });
    });
});

describe("purging the plain copies", () => {
    it("deletes only copies older than 30 days, in batches until none is left", async () => {
        for (let i = 0; i < 2500; i++) db.copies.push({ kind: "message", id: `old${i}`, createdAt: new Date(NOW.getTime() - 31 * DAY) });
        db.copies.push({ kind: "message", id: "fresh", createdAt: new Date(NOW.getTime() - 29 * DAY) });
        await expect(purgeRollbackCopies(NOW)).resolves.toBe(2500);
        expect(db.copies.map((c) => c.id)).toEqual(["fresh"]);
        expect(db.executed).toHaveLength(3);
        expect(db.executed[0]![0]).toEqual(new Date(NOW.getTime() - 30 * DAY));
    });
});

// The device's own helper, so a stand-in `this` seals the way a device does.
const sealKeyGaps = (MlsDevice.prototype as unknown as { sealKeyGaps: unknown }).sealKeyGaps;
const share = (MlsDevice.prototype as unknown as { shareLegacyKey: (c: string, now: number) => Promise<number> }).shareLegacyKey;

describe("passing the migrated history on", () => {
    it("lists members with an account key and no envelope, only up to the limit", async () => {
        db.historyKeys.push({ channelId: CHANNEL, epoch: LEGACY_EPOCH, recipient: "u1" });
        db.accountKeys.push({ userId: "u1", hpkePublicKey: new Uint8Array([1]) }, { userId: "u2", hpkePublicKey: new Uint8Array([2]) }, { userId: "u4", hpkePublicKey: new Uint8Array([4]) });
        const gaps = await legacyKeyGaps(CHANNEL, LEGACY_EPOCH, ["u1", "u2", "u3", "u4"]);
        expect(gaps.map((g) => g.userId)).toEqual(["u2", "u4"]);
        await expect(legacyKeyGaps(CHANNEL, LEGACY_EPOCH, ["u1", "u2", "u3", "u4"], 1)).resolves.toHaveLength(1);
    });

    it("seals the key it holds to each member missing it, so their account key opens it, at most every ten minutes", async () => {
        const lateKey = generateAccountKey();
        const late = { publicKey: (await accountPublicKeys(lateKey)).hpkePublicKey, privateKey: (await accountHpkeKeyPair(lateKey)).privateKey };
        const historyKey = content.newHistoryKey();
        const sent: Record<string, unknown>[] = [];
        const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
        const device = {
            legacyShared: new Map<string, number>(),
            options: { userId: "u1" },
            sealKeyGaps,
            historyKey: vi.fn(async () => historyKey),
            send: vi.fn(async (body: Record<string, unknown>) => {
                sent.push(body);
                return body.op === "legacy-key-gaps" ? { accountKeys: [{ userId: "u1", hpkePublicKey: "x" }, { userId: "u2", hpkePublicKey: b64(late.publicKey) }] } : { ok: true };
            })
        };
        await expect(share.call(device, CHANNEL, 1000)).resolves.toBe(1);
        const put = sent.find((b) => b.op === "put-history-keys") as { epoch: string; envelopes: { recipient: string; envelope: string }[] };
        expect(put.epoch).toBe(LEGACY_EPOCH.toString());
        expect(put.envelopes.map((e) => e.recipient)).toEqual(["u2"]);
        const opened = await content.openHistoryKey(late.privateKey, new Uint8Array(Buffer.from(put.envelopes[0]!.envelope, "base64url")), { recipient: "u2", conversationId: CHANNEL, epoch: LEGACY_EPOCH });
        expect(opened).toEqual(historyKey);
        await expect(share.call(device, CHANNEL, 1000 + 60_000)).resolves.toBe(0);
        expect(sent.filter((b) => b.op === "legacy-key-gaps")).toHaveLength(1);
    });

    it("asks for no key and seals nothing when nobody is missing it", async () => {
        const device = { legacyShared: new Map(), options: { userId: "u1" }, sealKeyGaps, historyKey: vi.fn(), send: vi.fn(async () => ({ accountKeys: [] })) };
        await expect(share.call(device, CHANNEL, 0)).resolves.toBe(0);
        expect(device.historyKey).not.toHaveBeenCalled();
    });
});

describe("passing each sweep's key on", () => {
    it("seals every server-sealed epoch it is named, page after page, each under its own epoch, and only keys it holds", async () => {
        const lateKey = generateAccountKey();
        const late = { publicKey: (await accountPublicKeys(lateKey)).hpkePublicKey, privateKey: (await accountHpkeKeyPair(lateKey)).privateKey };
        const keys = new Map<bigint, Uint8Array>([[SWEEP_EPOCH_TOP, content.newHistoryKey()], [SWEEP_EPOCH_TOP - 8n, content.newHistoryKey()]]);
        const sent: Record<string, unknown>[] = [];
        const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
        const gap = [{ userId: "u2", hpkePublicKey: b64(late.publicKey) }];
        const pages: Record<string, unknown>[] = [
            // A key this device has no copy of (TOP - 1) is skipped: nothing is sealed for it.
            { accountKeys: [], epochs: [{ epoch: SWEEP_EPOCH_TOP.toString(), accountKeys: gap }, { epoch: (SWEEP_EPOCH_TOP - 1n).toString(), accountKeys: gap }], next: (SWEEP_EPOCH_TOP - 7n).toString() },
            { accountKeys: [], epochs: [{ epoch: (SWEEP_EPOCH_TOP - 8n).toString(), accountKeys: gap }], next: null }
        ];
        const device = {
            legacyShared: new Map<string, number>(),
            options: { userId: "u1" },
            sealKeyGaps,
            historyKey: vi.fn(async (_channel: string, epoch: bigint) => keys.get(epoch) ?? null),
            send: vi.fn(async (body: Record<string, unknown>) => {
                sent.push(body);
                return body.op === "legacy-key-gaps" ? pages.shift()! : { ok: true };
            })
        };
        await expect(share.call(device, CHANNEL, 1000)).resolves.toBe(2);
        const asks = sent.filter((b) => b.op === "legacy-key-gaps");
        expect(asks.map((b) => b.upTo)).toEqual([undefined, (SWEEP_EPOCH_TOP - 7n).toString()]);
        const puts = sent.filter((b) => b.op === "put-history-keys") as { epoch: string; envelopes: { recipient: string; envelope: string }[] }[];
        expect(puts.map((p) => p.epoch)).toEqual([SWEEP_EPOCH_TOP.toString(), (SWEEP_EPOCH_TOP - 8n).toString()]);
        for (const put of puts) {
            const epoch = BigInt(put.epoch);
            const opened = await content.openHistoryKey(late.privateKey, new Uint8Array(Buffer.from(put.envelopes[0]!.envelope, "base64url")), { recipient: "u2", conversationId: CHANNEL, epoch });
            expect(opened).toEqual(keys.get(epoch));
        }
    });

    it("stops at a page that answers the cursor it was asked with, and after four pages", async () => {
        const again = { accountKeys: [], epochs: [], next: "5" };
        const device = { legacyShared: new Map(), options: { userId: "u1" }, sealKeyGaps, historyKey: vi.fn(), send: vi.fn(async (body: Record<string, unknown>) => (body.upTo === "5" ? again : { ...again, next: "5" })) };
        await expect(share.call(device, CHANNEL, 0)).resolves.toBe(0);
        expect(device.send).toHaveBeenCalledTimes(2);
        let n = 100;
        const endless = { legacyShared: new Map(), options: { userId: "u1" }, sealKeyGaps, historyKey: vi.fn(), send: vi.fn(async () => ({ accountKeys: [], epochs: [], next: String(n--) })) };
        await expect(share.call(endless, CHANNEL, 0)).resolves.toBe(0);
        expect(endless.send).toHaveBeenCalledTimes(4);
    });
});
