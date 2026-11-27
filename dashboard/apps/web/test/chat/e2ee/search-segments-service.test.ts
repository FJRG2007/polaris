/**
 * Shared search segments through the route (docs/chat-e2ee-mls.md, "Shared
 * search segments"): who may build and read them, the lease, corrections and
 * compaction, the device-side builder and reader, and the migrator's own.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
    tables: {} as Record<string, Row[]>,
    user: null as { id: string } | null,
    members: new Set<string>(),
    seq: 0n
}));

vi.mock("@/lib/session", () => ({ backgroundUser: async () => state.user }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/chat/access", () => ({
    channelAccess: async (actor: { id: string }, channelId: string) => (state.members.has(`${actor.id}:${channelId}`) ? { id: channelId } : null),
    conversationAudience: async () => null
}));
vi.mock("@polaris/db", async () => ({ prisma: (await import("./support/mls-tables")).memoryPrisma(state), Prisma: { DbNull: null } }));

const { handleMls } = await import("@/lib/chat/e2ee/mls-handler");
const segment = await import("@/lib/chat/e2ee/search-segment");
const service = await import("@/lib/chat/e2ee/search-segments-service");
const client = await import("@/lib/chat/e2ee/search-segments-client");

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const EVE = "33333333-3333-4333-8333-333333333333";
const CHANNEL = "0192f5a0-0000-7000-8000-00000000c001";
const OTHER = "0192f5a0-0000-7000-8000-00000000c002";
const CONTENT_SIGNATURE_LABEL = new TextEncoder().encode("polaris/chat-e2ee/content-signature/v1\u0000");
const msgId = (n: number) => `0192f5a0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const hk = (channelId: string, epoch: bigint) => new Uint8Array(32).fill(Number((BigInt(channelId.length) + epoch) % 200n) + 1);

async function call(body: unknown, as: string): Promise<{ status: number; body: Record<string, unknown> }> {
    state.user = { id: as };
    const response = await handleMls(new Request("http://x/api/e2ee/mls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

interface Fake {
    device: import("@/lib/chat/e2ee/search-segments-client").SegmentDevice;
    privateKey: KeyObject;
}

/**
 * Which leaves this device's copy of the group holds: every registered device
 * (`"all"`), these addresses only, or no copy at all (`"none"`).
 */
type GroupCopy = "all" | "none" | ReadonlySet<string>;

/** A browser device of `userId`: registered with its Ed25519 key, holding the history keys its account holds. */
function fakeDevice(userId: string, name: string, current: bigint | null = 9n, group: GroupCopy = "all"): Fake {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    (state.tables.mlsDevice ??= []).push({ userId, device: name, signatureKey: Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32)), retiredAt: null, lastSeenAt: new Date() });
    return {
        privateKey,
        device: {
            historyKey: async (channelId, epoch) =>
                (state.tables.chatHistoryKey ?? []).some((r) => r.channelId === channelId && r.epoch === epoch && r.recipient === userId) ? hk(channelId, epoch) : null,
            currentEpoch: () => current,
            memberSignatureKey: (_channelId, address) => {
                if (group === "none") return undefined;
                if (group !== "all" && !group.has(address)) return null;
                const leaf = (state.tables.mlsDevice ?? []).find((r) => `${r.userId}/${r.device}` === address);
                return leaf ? new Uint8Array(leaf.signatureKey as Buffer) : null;
            },
            signSearchSegment: (payload) => new Uint8Array(sign(null, Buffer.concat([CONTENT_SIGNATURE_LABEL, payload]), privateKey)),
            searchSegments: async (body) => {
                const named = body.op === "claim-index-build" || body.op === "put-index-segment" ? { ...body, device: name } : body;
                const answer = await call(named, userId);
                if (answer.status !== 200) throw Object.assign(new Error(String(answer.body.error)), { reason: answer.body.error });
                return answer.body;
            }
        }
    };
}

/** What a device opened: its own index, as the builder reads it. */
function source(bodies: Map<string, { body: string; editedAt?: string }>, channelId = CHANNEL): import("@/lib/chat/e2ee/search-segments-client").SegmentSource {
    return {
        loaded: async () => undefined,
        entry: (id) => {
            const kept = bodies.get(id);
            return kept ? { id, channelId, body: kept.body, ...(kept.editedAt ? { editedAt: kept.editedAt } : {}) } : undefined;
        }
    };
}

function message(n: number, epoch: bigint, extra: Row = {}): Row {
    const row = { id: msgId(n), channelId: CHANNEL, e2eeEpoch: epoch, deletedAt: null, expiresAt: null, audience: [], editedAt: null, createdAt: new Date(), ...extra };
    (state.tables.chatMessage ??= []).push(row);
    return row;
}

function holdKey(userId: string, epoch: bigint, channelId = CHANNEL): void {
    (state.tables.chatHistoryKey ??= []).push({ channelId, epoch, recipient: userId, envelope: Buffer.alloc(64) });
}

beforeEach(() => {
    process.env.POLARIS_INTERNAL_CHAT_E2EE = "1";
    state.tables = {};
    state.members = new Set([`${ALICE}:${CHANNEL}`, `${BOB}:${CHANNEL}`, `${EVE}:${CHANNEL}`, `${ALICE}:${OTHER}`]);
    holdKey(ALICE, 5n);
    holdKey(BOB, 5n);
});

describe("the lease", () => {
    it("goes to one device at a time, until it lapses", async () => {
        fakeDevice(ALICE, "alice-device-1");
        fakeDevice(BOB, "bob-device-01");
        const claim = (as: string, device: string) => call({ op: "claim-index-build", channelId: CHANNEL, device, epoch: "5", seq: 0 }, as);
        expect((await claim(ALICE, "alice-device-1")).body.granted).toBe(true);
        expect((await claim(BOB, "bob-device-01")).body.granted).toBe(false);
        expect((await claim(ALICE, "alice-device-1")).body.granted).toBe(true);
        state.tables.chatSearchLease![0]!.until = new Date(Date.now() - 1);
        expect((await claim(BOB, "bob-device-01")).body.granted).toBe(true);
    });

    it("is refused to an account without the epoch's history key", async () => {
        fakeDevice(EVE, "eve-device-01");
        const answer = await call({ op: "claim-index-build", channelId: CHANNEL, device: "eve-device-01", epoch: "5", seq: 0 }, EVE);
        expect(answer).toEqual({ status: 409, body: { error: "noHistoryKey" } });
    });
});

describe("the stretch", () => {
    it("names only sealed messages of the epoch every member may see, oldest first", async () => {
        message(1, 5n);
        message(2, 5n, { audience: [ALICE] });
        message(3, 5n, { expiresAt: new Date(Date.now() + 60_000) });
        message(4, 5n, { deletedAt: new Date() });
        message(5, 6n);
        message(6, 5n, { editedAt: new Date("2026-11-27T10:00:00.000Z") });
        const answer = await call({ op: "index-stretch", channelId: CHANNEL, epoch: "5" }, ALICE);
        expect(answer.body).toEqual({ messages: [{ id: msgId(1) }, { id: msgId(6), editedAt: "2026-11-27T10:00:00.000Z" }], more: false });
        expect((await call({ op: "index-stretch", channelId: CHANNEL, epoch: "5" }, EVE)).status).toBe(409);
        expect((await call({ op: "index-stretch", channelId: OTHER, epoch: "5" }, BOB)).status).toBe(403);
    });
});

describe("building and reading", () => {
    it("builds an ended epoch once, and a new browser of another member finds it", async () => {
        for (let n = 1; n <= 3; n++) message(n, 5n);
        const alice = fakeDevice(ALICE, "alice-device-1");
        const opened = new Map([
            [msgId(1), { body: "Budget meeting Friday" }],
            [msgId(2), { body: "lunch?" }],
            [msgId(3), { body: "the budget is approved" }]
        ]);
        expect(await client.buildSegments(alice.device, source(opened), CHANNEL, 5n)).toBe(1);
        // Built: nothing more to do, and no lease left behind.
        expect(await client.buildSegments(alice.device, source(opened), CHANNEL, 5n)).toBe(0);
        expect(state.tables.chatSearchLease ?? []).toEqual([]);
        const row = state.tables.chatSearchSegment![0]!;
        expect(row).toMatchObject({ channelId: CHANNEL, epoch: 5n, seq: 0, generation: 0, base: true, messages: 3, lastId: msgId(3), builder: `${ALICE}/alice-device-1` });

        const bob = fakeDevice(BOB, "bob-new-browser");
        const reader = new client.SegmentReader(bob.device, client.pageSearchHost());
        await reader.refresh();
        expect((await reader.search("budget", null, 10)).map((h) => h.id)).toEqual([msgId(3), msgId(1)]);
        expect(await reader.search("budget", OTHER, 10)).toEqual([]);
    });

    it("waits while a stretch is missing a message here, or the epoch is still open and not full", async () => {
        message(1, 5n);
        message(2, 5n);
        const partial = new Map([[msgId(1), { body: "one" }]]);
        expect(await client.buildSegments(fakeDevice(ALICE, "alice-device-1").device, source(partial), CHANNEL, 5n)).toBe(0);
        const whole = new Map([...partial, [msgId(2), { body: "two" }]]);
        expect(await client.buildSegments(fakeDevice(BOB, "bob-device-01", 5n).device, source(whole), CHANNEL, 5n)).toBe(0);
        expect(state.tables.chatSearchSegment ?? []).toEqual([]);
    });

    it("lists a segment only to accounts holding its epoch's key", async () => {
        message(1, 5n);
        await client.buildSegments(fakeDevice(ALICE, "alice-device-1").device, source(new Map([[msgId(1), { body: "secret plan" }]])), CHANNEL, 5n);
        expect(((await call({ op: "index-segments" }, BOB)).body.segments as unknown[]).length).toBe(1);
        expect((await call({ op: "index-segments" }, EVE)).body.segments).toEqual([]);
        expect((await call({ op: "index-segment", channelId: CHANNEL, epoch: "5", seq: 0, generation: 0 }, EVE)).status).toBe(409);
        state.members.delete(`${BOB}:${CHANNEL}`);
        expect((await call({ op: "index-segments" }, BOB)).body.segments).toEqual([]);
    });
});

describe("signatures on the reader", () => {
    const text = (b: Uint8Array) => Buffer.from(b).toString("base64url");

    /** A segment put straight into the table, as a server that does not check would keep it. */
    async function forged(builder: string, privateKey: KeyObject, epoch = 5n, body = "forged budget") {
        const binding = { channelId: CHANNEL, epoch, seq: 0, generation: 0 };
        const { nonce, ciphertext } = await segment.sealSegment(await segment.indexKey(hk(CHANNEL, epoch), CHANNEL, epoch), binding, segment.buildIndex([{ id: msgId(1), body }]));
        const signature = sign(null, Buffer.concat([CONTENT_SIGNATURE_LABEL, await segment.segmentSignaturePayload(binding, nonce, ciphertext)]), privateKey);
        (state.tables.chatSearchSegment ??= []).push({
            ...binding,
            base: true,
            messages: 1,
            lastId: msgId(1),
            nonce: Buffer.from(nonce),
            ciphertext: Buffer.from(ciphertext),
            builder,
            signature,
            createdAt: new Date()
        });
        return { nonce, ciphertext, signature };
    }

    it("leaves out a segment signed by a key that is not its builder's leaf, and the builder rebuilds it", async () => {
        message(1, 5n);
        const alice = fakeDevice(ALICE, "alice-device-1");
        const stranger = generateKeyPairSync("ed25519").privateKey;
        await forged(`${ALICE}/alice-device-1`, stranger);
        const bob = fakeDevice(BOB, "bob-new-browser");
        const reader = new client.SegmentReader(bob.device, client.pageSearchHost());
        await reader.refresh();
        expect(await reader.search("budget", null, 10)).toEqual([]);

        // Alice's builder takes the forged base for a missing one and writes the next generation over it.
        expect(await client.buildSegments(alice.device, source(new Map([[msgId(1), { body: "the real budget" }]])), CHANNEL, 5n)).toBe(1);
        expect(state.tables.chatSearchSegment!.map((r) => r.generation)).toEqual([1]);
        await reader.refresh();
        expect((await reader.search("real", null, 10)).map((h) => h.id)).toEqual([msgId(1)]);
    });

    it("leaves out a segment whose builder holds no leaf in this device's group, whatever key the server names", async () => {
        message(1, 5n);
        const eve = fakeDevice(EVE, "eve-device-01");
        await forged(`${EVE}/eve-device-01`, eve.privateKey);
        const outside = fakeDevice(BOB, "bob-device-01", 9n, new Set([`${ALICE}/alice-device-1`]));
        const reader = new client.SegmentReader(outside.device, client.pageSearchHost());
        await reader.refresh();
        expect(await reader.search("budget", null, 10)).toEqual([]);
        // The same segment where its builder is a member is taken.
        const inside = new client.SegmentReader(fakeDevice(BOB, "bob-device-02").device, client.pageSearchHost());
        await inside.refresh();
        expect((await inside.search("budget", null, 10)).map((h) => h.id)).toEqual([msgId(1)]);
    });

    it("checks against the device's registered key only where this device holds no copy of the group", async () => {
        message(1, 5n);
        const alice = fakeDevice(ALICE, "alice-device-1");
        const { nonce, ciphertext, signature } = await forged(`${ALICE}/alice-device-1`, alice.privateKey);
        const groupless = fakeDevice(BOB, "bob-device-01", null, "none").device;
        const binding = { channelId: CHANNEL, epoch: 5n, seq: 0, generation: 0 };
        const registered = text(new Uint8Array((state.tables.mlsDevice ?? []).find((r) => r.device === "alice-device-1")!.signatureKey as Buffer));
        const answer = { builder: `${ALICE}/alice-device-1`, signature: text(signature), signatureKey: registered };
        expect(await client.signedSegment(groupless, binding, nonce, ciphertext, answer)).toBe(true);
        const other = text(new Uint8Array(generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32)));
        expect(await client.signedSegment(groupless, binding, nonce, ciphertext, { ...answer, signatureKey: other })).toBe(false);
        expect(await client.signedSegment(groupless, binding, nonce, ciphertext, { ...answer, signature: undefined })).toBe(false);
        // With a copy of the group, the key the server names is never what is checked.
        const member = fakeDevice(BOB, "bob-device-02", 9n, new Set()).device;
        expect(await client.signedSegment(member, binding, nonce, ciphertext, answer)).toBe(false);
    });

    it("takes a migrated segment only in the legacy epoch", async () => {
        message(1, 5n);
        holdKey(BOB, 5n);
        const run = generateKeyPairSync("ed25519");
        (state.tables.chatMigration ??= []).push({ channelId: CHANNEL, state: "cut", signKey: Buffer.from(run.publicKey.export({ format: "der", type: "spki" }).subarray(-32)) });
        await forged("migration", run.privateKey);
        const reader = new client.SegmentReader(fakeDevice(BOB, "bob-device-01").device, client.pageSearchHost());
        await reader.refresh();
        expect(await reader.search("budget", null, 10)).toEqual([]);
    });
});

describe("refusals", () => {
    async function sealed(fake: Fake, generation = 0) {
        const binding = { channelId: CHANNEL, epoch: 5n, seq: 0, generation };
        const { nonce, ciphertext } = await segment.sealSegment(await segment.indexKey(hk(CHANNEL, 5n), CHANNEL, 5n), binding, segment.buildIndex([{ id: msgId(1), body: "x" }]));
        const signature = fake.device.signSearchSegment(await segment.segmentSignaturePayload(binding, nonce, ciphertext));
        const text = (b: Uint8Array) => Buffer.from(b).toString("base64url");
        return { op: "put-index-segment", channelId: CHANNEL, epoch: "5", seq: 0, generation, messages: 1, lastId: msgId(1), nonce: text(nonce), ciphertext: text(ciphertext), signature: text(signature) };
    }

    it("refuses a base without the lease, a signature not the device's, a gap and an older generation", async () => {
        const alice = fakeDevice(ALICE, "alice-device-1");
        const bob = fakeDevice(BOB, "bob-device-01");
        expect((await call({ ...(await sealed(alice)), device: "alice-device-1", base: true }, ALICE)).body.error).toBe("notLeased");
        expect((await call({ ...(await sealed(bob)), device: "alice-device-1", base: false }, ALICE)).body.error).toBe("badSignature");
        expect((await call({ ...(await sealed(alice)), device: "alice-device-1", base: false, seq: 1 }, ALICE)).body.error).toBe("badSignature");
        expect((await call({ ...(await sealed(alice, 2)), device: "alice-device-1", base: false }, ALICE)).body).toEqual({ ok: true });
        expect((await call({ ...(await sealed(alice, 1)), device: "alice-device-1", base: false }, ALICE)).body.error).toBe("stale");
        expect((await call({ ...(await sealed(bob)), device: "bob-device-01", base: false, ciphertext: "AAAA" }, BOB)).status).toBe(400);
    });
});

describe("edits", () => {
    it("adds a correction the reader prefers, and a new base past a quarter removes the older generations", async () => {
        for (let n = 1; n <= 4; n++) message(n, 5n);
        const alice = fakeDevice(ALICE, "alice-device-1");
        const opened = new Map<string, { body: string; editedAt?: string }>([1, 2, 3, 4].map((n) => [msgId(n), { body: `old words ${n}` }]));
        await client.buildSegments(alice.device, source(opened), CHANNEL, 5n);
        const editedAt = "2026-11-27T10:00:00.000Z";
        expect(await client.writeCorrection(alice.device, CHANNEL, 5n, { id: msgId(2), editedAt, body: "fresh words" })).toBe(true);
        const bob = fakeDevice(BOB, "bob-device-01");
        const reader = new client.SegmentReader(bob.device, client.pageSearchHost());
        await reader.refresh();
        expect((await reader.search("fresh", null, 10)).map((h) => h.id)).toEqual([msgId(2)]);
        expect((await reader.search("old", null, 10)).map((h) => h.id)).toEqual([msgId(4), msgId(3), msgId(1)]);

        // A second correction passes a quarter of four: the next build writes a new base over all of them.
        await client.writeCorrection(alice.device, CHANNEL, 5n, { id: msgId(3), editedAt, body: "fresh again" });
        state.tables.chatMessage!.find((r) => r.id === msgId(2))!.editedAt = new Date(editedAt);
        state.tables.chatMessage!.find((r) => r.id === msgId(3))!.editedAt = new Date(editedAt);
        opened.set(msgId(2), { body: "fresh words", editedAt });
        opened.set(msgId(3), { body: "fresh again", editedAt });
        expect(await client.buildSegments(alice.device, source(opened), CHANNEL, 5n)).toBe(1);
        expect(state.tables.chatSearchSegment!.map((r) => [r.generation, r.base])).toEqual([[3, true]]);
    });

    it("writes no correction where no segment names the message yet", async () => {
        message(1, 5n);
        expect(await client.writeCorrection(fakeDevice(ALICE, "alice-device-1").device, CHANNEL, 5n, { id: msgId(1), body: "x" })).toBe(false);
    });

    it("rebuilds a base that misses a message of its stretch", async () => {
        message(1, 5n);
        message(3, 5n);
        const alice = fakeDevice(ALICE, "alice-device-1");
        await client.buildSegments(alice.device, source(new Map([[msgId(1), { body: "one" }], [msgId(3), { body: "three" }]])), CHANNEL, 5n);
        // A message the server lists inside the stretch that the base does not name (a lying or late segment).
        message(2, 5n);
        expect(await client.buildSegments(alice.device, source(new Map([[msgId(1), { body: "one" }], [msgId(2), { body: "two" }], [msgId(3), { body: "three" }]])), CHANNEL, 5n)).toBe(1);
        expect(state.tables.chatSearchSegment!.map((r) => [r.generation, r.messages])).toEqual([[1, 3]]);
    });
});

describe("migrated history", () => {
    it("is indexed by the migrator from the words it kept, readable with the legacy key", async () => {
        const LEGACY = 9223372036854775807n;
        holdKey(BOB, LEGACY);
        message(1, LEGACY);
        message(2, LEGACY);
        (state.tables.chatMigrationRollback ??= []).push(
            { kind: "message", id: msgId(1), messageId: msgId(1), channelId: CHANNEL, body: "migrated invoice" },
            { kind: "message", id: msgId(2), messageId: msgId(2), channelId: CHANNEL, body: "something else" }
        );
        const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
        // The run's public key, as the migration keeps it (`ChatMigration.signKey`) and a reader checks it.
        (state.tables.chatMigration ??= []).push({ channelId: CHANNEL, state: "cut", signKey: Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)) });
        expect(await service.indexMigrated(CHANNEL, LEGACY, hk(CHANNEL, LEGACY), { privateKey: pair.privateKey })).toBe(1);
        expect(state.tables.chatSearchSegment![0]).toMatchObject({ builder: "migration", base: true, messages: 2 });
        const reader = new client.SegmentReader(fakeDevice(BOB, "bob-device-01").device, client.pageSearchHost());
        await reader.refresh();
        expect((await reader.search("invoice", CHANNEL, 10)).map((h) => h.id)).toEqual([msgId(1)]);
    });
});
