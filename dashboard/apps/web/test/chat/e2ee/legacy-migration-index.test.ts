/**
 * A migration that reaches its cut indexes the history it sealed
 * (`legacy-migration.ts migrateConversation` -> `indexMigrated`): the whole
 * run over the in-memory tables, then a member's new browser - one that never
 * opened a migrated message - finds it through the shared segments, under the
 * history key sealed to that member and the run's own signing key.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
    tables: {} as Record<string, Row[]>,
    user: null as { id: string } | null,
    members: new Set<string>(),
    seq: 0n,
    // The migrator's calls into the segments, and whether the next one fails.
    indexed: [] as unknown[][],
    failIndex: false
}));

vi.mock("@/lib/session", () => ({ backgroundUser: async () => state.user }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/chat/access", () => ({
    channelAccess: async (actor: { id: string }, channelId: string) => (state.members.has(`${actor.id}:${channelId}`) ? { id: channelId } : null),
    conversationAudience: async (_actor: { id: string }, channelId: string) =>
        [...state.members].filter((m) => m.endsWith(`:${channelId}`)).map((m) => m.slice(0, m.indexOf(":")))
}));
vi.mock("@/lib/chat/e2ee/search-segments-service", async (original) => {
    const real = await original<typeof import("@/lib/chat/e2ee/search-segments-service")>();
    return {
        ...real,
        indexMigrated: async (...args: Parameters<typeof real.indexMigrated>) => {
            state.indexed.push(args);
            if (state.failIndex) throw new Error("segment store down");
            return real.indexMigrated(...args);
        }
    };
});
vi.mock("@polaris/db", async () => ({ prisma: (await import("./support/mls-tables")).memoryPrisma(state), Prisma: { DbNull: null } }));

const { handleMls } = await import("@/lib/chat/e2ee/mls-handler");
const migration = await import("@/lib/chat/e2ee/legacy-migration");
const client = await import("@/lib/chat/e2ee/search-segments-client");
const content = await import("@polaris/chat-crypto/message-content");
const accountKeys = await import("@polaris/chat-crypto/account-key");

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CHANNEL = "0192f5a0-0000-7000-8000-00000000c001";
const msgId = (n: number) => `0192f5a0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

async function call(body: unknown, as: string): Promise<{ status: number; body: Record<string, unknown> }> {
    state.user = { id: as };
    const response = await handleMls(new Request("http://x/api/e2ee/mls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function plain(n: number, body: string): void {
    (state.tables.chatMessage ??= []).push({
        id: msgId(n),
        channelId: CHANNEL,
        kind: "text",
        body,
        translation: null,
        clientKey: null,
        e2eeCiphertext: null,
        e2eeDevice: null,
        edits: [],
        deletedAt: null,
        expiresAt: null,
        audience: [],
        editedAt: null,
        createdAt: new Date()
    });
}

/** Bob's new browser: no copy of any group, the history keys sealed to his account opened with his account key. */
function newBrowser(hpkePrivateKey: CryptoKey): import("@/lib/chat/e2ee/search-segments-client").SegmentDevice {
    return {
        historyKey: async (channelId, epoch) => {
            const sealed = (state.tables.chatHistoryKey ?? []).find((r) => r.channelId === channelId && r.epoch === epoch && r.recipient === BOB);
            if (!sealed) return null;
            return content.openHistoryKey(hpkePrivateKey, new Uint8Array(sealed.envelope as Buffer), { recipient: BOB, conversationId: channelId, epoch });
        },
        currentEpoch: () => null,
        memberSignatureKey: () => undefined,
        signSearchSegment: () => {
            throw new Error("a reader signs nothing");
        },
        searchSegments: async (body) => {
            const answer = await call(body, BOB);
            if (answer.status !== 200) throw new Error(String(answer.body.error));
            return answer.body;
        }
    };
}

let bobKey: CryptoKey;

beforeEach(async () => {
    process.env.POLARIS_INTERNAL_CHAT_E2EE = "1";
    state.tables = {};
    state.indexed = [];
    state.failIndex = false;
    state.members = new Set([`${ALICE}:${CHANNEL}`, `${BOB}:${CHANNEL}`]);
    state.tables.chatChannelMember = [
        { channelId: CHANNEL, userId: ALICE },
        { channelId: CHANNEL, userId: BOB }
    ];
    for (const userId of [ALICE, BOB]) {
        const ak = accountKeys.generateAccountKey();
        const { signPublicKey, hpkePublicKey } = await accountKeys.accountPublicKeys(ak);
        (state.tables.chatAccountKey ??= []).push({ userId, akVersion: 1, signPublicKey: Buffer.from(signPublicKey), hpkePublicKey: Buffer.from(hpkePublicKey) });
        if (userId === BOB) bobKey = (await accountKeys.accountHpkeKeyPair(ak)).privateKey;
    }
});

describe("migration indexes its history after the cut", () => {
    it("writes the legacy epoch's segments, which a member's new browser finds", async () => {
        plain(1, "the migrated invoice is paid");
        plain(2, "lunch on friday");
        plain(3, "invoice number two");

        expect(await migration.migrateConversation(CHANNEL)).toBe("cut");

        // Cut and emptied: the words are only in the rollback copies, and in the segment.
        const run = state.tables.chatMigration!.find((r) => r.channelId === CHANNEL)!;
        expect(run).toMatchObject({ state: "cut", reason: null, sealed: 3 });
        expect(state.tables.chatMessage!.every((r) => r.body === "" && r.e2eeDevice === migration.MIGRATION_DEVICE)).toBe(true);
        const segments = state.tables.chatSearchSegment ?? [];
        expect(segments).toHaveLength(1);
        expect(segments[0]).toMatchObject({ channelId: CHANNEL, epoch: migration.LEGACY_EPOCH, seq: 0, generation: 0, base: true, messages: 3, lastId: msgId(3), builder: "migration" });
        // Called once, after the cut, with the run's history key still whole (it is zeroed only once the run ends).
        expect(state.indexed).toHaveLength(1);
        expect(state.indexed[0]!.slice(0, 2)).toEqual([CHANNEL, migration.LEGACY_EPOCH]);

        const reader = new client.SegmentReader(newBrowser(bobKey), client.pageSearchHost());
        await reader.refresh();
        expect((await reader.search("invoice", CHANNEL, 10)).map((h) => h.id).sort()).toEqual([msgId(1), msgId(3)]);
        expect((await reader.search("friday", null, 10)).map((h) => h.id)).toEqual([msgId(2)]);
    });

    it("still cuts when its segments cannot be written, and a reader finds none", async () => {
        plain(1, "the migrated invoice is paid");
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        state.failIndex = true;
        try {
            expect(await migration.migrateConversation(CHANNEL)).toBe("cut");
            expect(state.indexed).toHaveLength(1);
            expect(errors).toHaveBeenCalledWith("polaris: a migrated conversation's search segments could not be written:", expect.any(Error));
        } finally {
            errors.mockRestore();
        }
        expect(state.tables.chatSearchSegment ?? []).toEqual([]);
    });
});
