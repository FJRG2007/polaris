/**
 * The legacy migration's extra copy of a conversation's history key for its
 * members with no account key yet: sealed to the live organisation recovery
 * key of each scope they belong to, once per key however many members share
 * it, to nobody when every member has a key, and never instead of the members'
 * own copies. The envelopes are real ones the recovery key opens.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    keyed: new Set<string>(),
    recoveryKeys: new Map<string, Array<{ id: string; hpkePublicKey: Uint8Array }>>(),
    asked: [] as string[][],
    stored: [] as Array<{ channelId: string; epoch: bigint; envelopes: Array<{ recipient: string; envelope: Uint8Array }> }>
}));

vi.mock("@polaris/db", () => ({ prisma: {}, Prisma: {} }));
vi.mock("@/lib/chat/access", () => ({ conversationAudience: vi.fn() }));
vi.mock("@/lib/chat/e2ee/annotation-rollback", () => ({ restoreAnnotations: vi.fn() }));
vi.mock("@/lib/chat/e2ee/mls-delivery", () => ({
    accountPublicKeys: async (userIds: readonly string[]) =>
        userIds.filter((id) => state.keyed.has(id)).map((userId) => ({ userId, akVersion: 1, signPublicKey: new Uint8Array(32), hpkePublicKey: new Uint8Array(1216) })),
    putHistoryKeys: async (channelId: string, epoch: bigint, envelopes: Array<{ recipient: string; envelope: Uint8Array }>) =>
        void state.stored.push({ channelId, epoch, envelopes: [...envelopes] })
}));
vi.mock("@/lib/chat/e2ee/recovery-keys", () => ({
    recoveryRecipient: (id: string) => `ork:${id}`,
    liveRecoveryKeysFor: async (userIds: readonly string[]) => {
        state.asked.push([...userIds]);
        const seen = new Map<string, { id: string; hpkePublicKey: Uint8Array }>();
        for (const id of userIds) for (const key of state.recoveryKeys.get(id) ?? []) seen.set(key.id, key);
        return [...seen.values()];
    }
}));

import * as content from "@polaris/chat-crypto/message-content";
import { recoveryKeyPair } from "@polaris/chat-crypto/recovery";
import { LEGACY_EPOCH, sealToRecoveryKeys } from "@/lib/chat/e2ee/legacy-migration";

const CHANNEL = "0192f000-0000-7000-8000-000000000001";
const seed = (n: number) => new Uint8Array(32).map((_, i) => (i * 13 + n) % 256);

beforeEach(() => {
    state.keyed.clear();
    state.recoveryKeys.clear();
    state.asked.length = 0;
    state.stored.length = 0;
});

describe("sealToRecoveryKeys", () => {
    it("seals the history key once to each live recovery key of the keyless members' scopes", async () => {
        const acme = await recoveryKeyPair(seed(1));
        const globex = await recoveryKeyPair(seed(2));
        state.keyed.add("kim");
        state.recoveryKeys.set("ana", [{ id: "acme-key", hpkePublicKey: acme.publicKey }]);
        state.recoveryKeys.set("bob", [{ id: "acme-key", hpkePublicKey: acme.publicKey }]);
        state.recoveryKeys.set("cy", [{ id: "globex-key", hpkePublicKey: globex.publicKey }]);
        // Kim has a key: her scope is never asked for, even if it has one.
        state.recoveryKeys.set("kim", [{ id: "kim-key", hpkePublicKey: globex.publicKey }]);
        const historyKey = content.newHistoryKey();

        expect(await sealToRecoveryKeys(CHANNEL, ["kim", "ana", "bob", "cy"], historyKey)).toBe(2);

        expect(state.asked.flat().sort()).toEqual(["ana", "bob", "cy"]);
        expect(state.stored).toHaveLength(1);
        const [put] = state.stored;
        expect(put!.channelId).toBe(CHANNEL);
        expect(put!.epoch).toBe(LEGACY_EPOCH);
        expect(put!.envelopes.map((e) => e.recipient).sort()).toEqual(["ork:acme-key", "ork:globex-key"]);
        const acmeCopy = put!.envelopes.find((e) => e.recipient === "ork:acme-key")!.envelope;
        const opened = await content.openHistoryKey(acme.privateKey, acmeCopy, { recipient: "ork:acme-key", conversationId: CHANNEL, epoch: LEGACY_EPOCH });
        expect(opened).toEqual(historyKey);
        // Bound to its recipient: the other key, or the same envelope named for another key, does not open it.
        await expect(
            content.openHistoryKey(globex.privateKey, acmeCopy, { recipient: "ork:acme-key", conversationId: CHANNEL, epoch: LEGACY_EPOCH })
        ).rejects.toThrow();
        await expect(
            content.openHistoryKey(acme.privateKey, acmeCopy, { recipient: "ork:globex-key", conversationId: CHANNEL, epoch: LEGACY_EPOCH })
        ).rejects.toThrow();
    });

    it("seals to nothing when every member has a key, or no scope has a recovery key yet", async () => {
        state.keyed.add("kim");
        expect(await sealToRecoveryKeys(CHANNEL, ["kim"], content.newHistoryKey())).toBe(0);
        expect(await sealToRecoveryKeys(CHANNEL, ["ana"], content.newHistoryKey())).toBe(0);
        expect(state.stored).toHaveLength(0);
    });

    it("binds the copy to the epoch it is given", async () => {
        const acme = await recoveryKeyPair(seed(3));
        state.recoveryKeys.set("ana", [{ id: "acme-key", hpkePublicKey: acme.publicKey }]);
        const historyKey = content.newHistoryKey();
        await sealToRecoveryKeys(CHANNEL, ["ana"], historyKey, 41n);
        const envelope = state.stored[0]!.envelopes[0]!.envelope;
        expect(state.stored[0]!.epoch).toBe(41n);
        expect(await content.openHistoryKey(acme.privateKey, envelope, { recipient: "ork:acme-key", conversationId: CHANNEL, epoch: 41n })).toEqual(historyKey);
        await expect(content.openHistoryKey(acme.privateKey, envelope, { recipient: "ork:acme-key", conversationId: CHANNEL, epoch: LEGACY_EPOCH })).rejects.toThrow();
    });
});
