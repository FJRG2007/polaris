/**
 * The chat MLS delivery service and its route: 404 with the flag off; commits
 * ordered by a compare-and-set on the epoch (two devices committing at once
 * never fork the group); a one-use key package handed out once, then the
 * last-resort one; a device reads the group log and only its own Welcomes;
 * and every op refused for an account outside the conversation, for a device
 * that is not the session's, and for an account named in it from outside.
 * The tables are an in-memory stand-in with the same semantics the service
 * relies on (unique keys, `updateMany` counts, all-or-nothing transactions).
 */

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readdirSync } from "node:fs";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
    tables: {} as Record<string, Row[]>,
    user: { id: "11111111-1111-4111-8111-111111111111" } as { id: string } | null,
    members: new Set<string>(),
    seq: 0n
}));

vi.mock("@/lib/session", () => ({ backgroundUser: async () => state.user }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
// The ordinary send, reduced to the row it writes: what a sealed message adds to it is under test here.
vi.mock("@/lib/chat/messages", () => ({
    send: async (actor: { id: string }, input: { channelId: string; body: string; clientKey?: string }, ...rest: unknown[]) => {
        const rows = (state.tables.chatMessage ??= []);
        const earlier = rows.find((r) => r.authorId === actor.id && r.clientKey === input.clientKey);
        if (earlier) return earlier.id;
        const id = crypto.randomUUID();
        rows.push({ id, channelId: input.channelId, authorId: actor.id, clientKey: input.clientKey, body: input.body, deletedAt: null, expiresAt: null, audience: [], replyToId: (rest[1] as { messageId?: string } | null)?.messageId ?? null, ...(rest[5] as Row) });
        return id;
    }
}));
vi.mock("@/lib/chat/access", () => ({
    channelAccess: async (actor: { id: string }, channelId: string) => (state.members.has(`${actor.id}:${channelId}`) ? { id: channelId } : null),
    conversationAudience: async (actor: { id: string }, channelId: string) =>
        state.members.has(`${actor.id}:${channelId}`)
            ? [...state.members].filter((m) => m.endsWith(`:${channelId}`)).map((m) => m.slice(0, m.indexOf(":")))
            : null
}));

vi.mock("@polaris/db", async () => ({ prisma: (await import("./support/mls-tables")).memoryPrisma(state) }));

const { handleMls } = await import("@/lib/chat/e2ee/mls-handler");
const { MlsDevice, MlsRequestError } = await import("@/lib/chat/e2ee/mls-client");
const accountKeys = await import("@polaris/chat-crypto/account-key");
const { IndexedDbHistoryKeyStore } = await import("@/lib/chat/e2ee/mls-history-keys");
type MlsHistoryKeyStore = import("@/lib/chat/e2ee/mls-history-keys").MlsHistoryKeyStore;
type MlsDevice = import("@/lib/chat/e2ee/mls-client").MlsDevice;
type MlsDeviceStore = import("@/lib/chat/e2ee/mls-client").MlsDeviceStore;
type MlsMemberClass = import("@/lib/chat/e2ee/mls-client").MlsMemberClass;
type MlsTransport = import("@/lib/chat/e2ee/mls-client").MlsTransport;

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const EVE = "33333333-3333-4333-8333-333333333333";
const CHANNEL = "44444444-4444-4444-8444-444444444444";
const blob = (fill: number, length = 40) => Buffer.alloc(length, fill).toString("base64url");

async function call(body: unknown, as: string | null = ALICE) {
    state.user = as ? { id: as } : null;
    const response = await handleMls(new Request("http://x/api/e2ee/mls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function device(userId: string, name: string) {
    expect((await call({ op: "register-device", device: name, signatureKey: blob(7, 32), e2eeVersion: 1 }, userId)).status).toBe(200);
}

beforeEach(() => {
    process.env.POLARIS_INTERNAL_CHAT_E2EE = "1";
    state.tables = {};
    state.seq = 0n;
    state.members = new Set([`${ALICE}:${CHANNEL}`, `${BOB}:${CHANNEL}`]);
});

describe("/api/e2ee/mls", () => {
    it("does not exist with the flag off, and needs a session and JSON", async () => {
        process.env.POLARIS_INTERNAL_CHAT_E2EE = "0";
        expect((await call({ op: "group", channelId: CHANNEL })).status).toBe(404);
        process.env.POLARIS_INTERNAL_CHAT_E2EE = "1";
        expect((await call({ op: "group", channelId: CHANNEL }, null)).status).toBe(401);
        expect((await call({ op: "group", channelId: "not-a-uuid" })).status).toBe(400);
        const plain = await handleMls(new Request("http://x", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }));
        expect(plain.status).toBe(400);
    });

    it("orders commits by epoch: the second commit for the same epoch is refused, not forked", async () => {
        await device(ALICE, "alice-laptop");
        await device(BOB, "bob-phone-1");
        expect((await call({ op: "create-group", channelId: CHANNEL, groupId: blob(1, 16), ciphersuite: 0x004f, groupInfo: blob(2) })).status).toBe(200);
        expect((await call({ op: "create-group", channelId: CHANNEL, groupId: blob(3, 16), ciphersuite: 0x004f, groupInfo: blob(2) })).body.error).toBe("groupExists");
        const commit = (as: string, name: string, payload: number) =>
            call({ op: "commit", channelId: CHANNEL, device: name, epoch: "0", commit: blob(payload), groupInfo: blob(payload + 1) }, as);
        const [first, second] = await Promise.all([commit(ALICE, "alice-laptop", 10), commit(BOB, "bob-phone-1", 20)]);
        expect([first.status, second.status].sort()).toEqual([200, 409]);
        expect([first.body.error, second.body.error]).toContain("staleEpoch");
        const group = (await call({ op: "group", channelId: CHANNEL })).body.group as { epoch: string };
        expect(group.epoch).toBe("1");
        expect(state.tables.mlsGroupEvent.filter((e) => e.kind === "commit")).toHaveLength(1);
    });

    it("hands a one-use key package out once, then the last-resort one", async () => {
        await device(BOB, "bob-phone-1");
        const publish = (keyPackages: string[], lastResort: boolean) =>
            call({ op: "publish-key-packages", device: "bob-phone-1", ciphersuite: 0x004f, keyPackages, lastResort }, BOB);
        expect((await publish([blob(5)], false)).status).toBe(200);
        expect((await publish([blob(6)], true)).status).toBe(200);
        const held = await call({ op: "register-device", device: "bob-phone-1", signatureKey: blob(7, 32), e2eeVersion: 1, ciphersuite: 0x004f }, BOB);
        expect(held.body.heldKeyPackages).toBe(1);
        const claim = () => call({ op: "claim-key-packages", channelId: CHANNEL, userIds: [BOB], ciphersuite: 0x004f });
        const [one, two, three] = [await claim(), await claim(), await claim()];
        const first = (r: { body: Record<string, unknown> }) => (r.body.keyPackages as { keyPackage: string; address: string }[])[0];
        expect(first(one)).toEqual({ address: `${BOB}/bob-phone-1`, keyPackage: blob(5) });
        expect(first(two).keyPackage).toBe(blob(6));
        expect(first(three).keyPackage).toBe(blob(6));
        expect((await call({ op: "publish-key-packages", device: "not-registered", ciphersuite: 0x004f, keyPackages: [blob(5)] }, BOB)).status).toBe(409);
        expect((await publish(Array.from({ length: 100 }, () => blob(9)), false)).status).toBe(200);
        expect((await publish([blob(9)], false)).body.error).toBe("tooManyKeyPackages");
    });

    it("keeps the last 256 epochs of a group's log and the GroupInfo to rejoin from", async () => {
        await device(ALICE, "alice-laptop");
        await call({ op: "create-group", channelId: CHANNEL, groupId: blob(1, 16), ciphersuite: 0x004f, groupInfo: blob(2) });
        for (let epoch = 0; epoch < 320; epoch++) {
            const moved = await call({ op: "commit", channelId: CHANNEL, device: "alice-laptop", epoch: String(epoch), commit: blob(10), groupInfo: blob(11) });
            expect(moved.status).toBe(200);
        }
        const epochs = state.tables.mlsGroupEvent.map((e) => e.epoch as bigint);
        // The group is at epoch 320, a multiple of 32: everything before 320 - 256 is gone.
        expect(epochs.reduce((a, b) => (a < b ? a : b))).toBe(64n);
        expect(epochs).toHaveLength(256);
        expect(((await call({ op: "group", channelId: CHANNEL })).body.group as { epoch: string; groupInfo: string }).groupInfo).toBe(blob(11));
    });

    it("gives a device the group log and only its own Welcomes", async () => {
        await device(ALICE, "alice-laptop");
        await device(BOB, "bob-phone-1");
        await call({ op: "create-group", channelId: CHANNEL, groupId: blob(1, 16), ciphersuite: 0x004f, groupInfo: blob(2) });
        const welcomes = [{ recipient: `${BOB}/bob-phone-1`, welcome: blob(30) }];
        expect((await call({ op: "commit", channelId: CHANNEL, device: "alice-laptop", epoch: "0", commit: blob(10), groupInfo: blob(11), welcomes })).status).toBe(200);
        await call({ op: "application", channelId: CHANNEL, device: "alice-laptop", epoch: "1", payload: blob(40) });
        const read = async (as: string, name: string) =>
            ((await call({ op: "events", channelId: CHANNEL, device: name }, as)).body.events as { kind: string }[]).map((e) => e.kind);
        expect(await read(BOB, "bob-phone-1")).toEqual(["commit", "welcome", "application"]);
        expect(await read(ALICE, "alice-laptop")).toEqual(["commit", "application"]);
        expect((await call({ op: "application", channelId: CHANNEL, device: "alice-laptop", epoch: "9", payload: blob(40) })).body.error).toBe("staleEpoch");
    });

    it("refuses accounts outside the conversation, devices that are not the session's, and outsiders named in an op", async () => {
        await device(ALICE, "alice-laptop");
        await device(EVE, "eve-laptop-1");
        await call({ op: "create-group", channelId: CHANNEL, groupId: blob(1, 16), ciphersuite: 0x004f, groupInfo: blob(2) });
        expect((await call({ op: "group", channelId: CHANNEL }, EVE)).status).toBe(403);
        expect((await call({ op: "events", channelId: CHANNEL, device: "eve-laptop-1" }, EVE)).status).toBe(403);
        // Bob's session cannot use Alice's device.
        expect((await call({ op: "events", channelId: CHANNEL, device: "alice-laptop" }, BOB)).status).toBe(403);
        expect((await call({ op: "claim-key-packages", channelId: CHANNEL, userIds: [EVE], ciphersuite: 0x004f })).status).toBe(403);
        const welcomes = [{ recipient: `${EVE}/eve-laptop-1`, welcome: blob(30) }];
        expect((await call({ op: "commit", channelId: CHANNEL, device: "alice-laptop", epoch: "0", commit: blob(10), groupInfo: blob(11), welcomes })).status).toBe(403);
        expect((await call({ op: "put-history-keys", channelId: CHANNEL, epoch: "1", envelopes: [{ recipient: EVE, envelope: blob(8, 100) }] })).status).toBe(403);
        expect(state.tables.mlsGroupEvent ?? []).toHaveLength(0);
    });

    it("stores history-key envelopes once and serves each account only its own", async () => {
        const envelopes = [
            { recipient: ALICE, envelope: blob(1, 100) },
            { recipient: BOB, envelope: blob(2, 100) },
            { recipient: "org", envelope: blob(3, 100) }
        ];
        expect((await call({ op: "put-history-keys", channelId: CHANNEL, epoch: "1", envelopes })).status).toBe(200);
        await call({ op: "put-history-keys", channelId: CHANNEL, epoch: "1", envelopes: [{ recipient: BOB, envelope: blob(9, 100) }] });
        const mine = (await call({ op: "history-keys", channelId: CHANNEL }, BOB)).body.historyKeys;
        expect(mine).toEqual([{ epoch: "1", envelope: blob(2, 100) }]);
    });

    it("serves the public account keys of members only, and answers an outsider like a member with no key", async () => {
        const keyless = "77777777-7777-4777-8777-777777777777";
        state.members.add(`${keyless}:${CHANNEL}`);
        const key = (userId: string, fill: number) => ({
            userId,
            akVersion: 1,
            signPublicKey: Buffer.alloc(32, fill),
            hpkePublicKey: Buffer.alloc(1216, fill + 1)
        });
        state.tables.chatAccountKey = [key(ALICE, 1), key(BOB, 3), key(EVE, 5)];
        const ask = (userIds: string[], as = ALICE) => call({ op: "account-keys", channelId: CHANNEL, userIds }, as);
        const bob = { userId: BOB, akVersion: 1, signPublicKey: blob(3, 32), hpkePublicKey: blob(4, 1216) };
        expect((await ask([BOB, BOB])).body).toEqual({ accountKeys: [bob] });
        // Eve has a key but is outside the conversation; the keyless member has none. Same answer.
        expect((await ask([EVE])).body).toEqual({ accountKeys: [] });
        expect((await ask([keyless])).body).toEqual({ accountKeys: [] });
        expect((await ask([BOB, EVE, keyless])).body).toEqual({ accountKeys: [bob] });
        // An outsider asking learns nothing at all.
        expect((await ask([BOB], EVE)).status).toBe(403);
        expect((await ask([])).status).toBe(400);
    });
});

// A device driven by `MlsDevice` against this route, with the real MLS member
// (the Node binding). Skipped where the binding is not built: the protocol
// itself is covered by packages/core-rs, this covers the client's ordering.
const nativeDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../../packages/core-rs/native");
const nativeFile = existsSync(nativeDir) ? readdirSync(nativeDir).find((f) => f.startsWith(`polaris-core.${process.platform}-${process.arch}`)) : undefined;
// CI's MLS job builds the binding and sets this, so a binding that failed to
// land there fails the run instead of skipping the suite.
if (process.env.POLARIS_REQUIRE_CORE_RS_NATIVE && !nativeFile) throw new Error(`no Node binding of @polaris/core-rs for ${process.platform}-${process.arch} in ${nativeDir}`);
const CAROL = "55555555-5555-4555-8555-555555555555";
const DAVE = "66666666-6666-4666-8666-666666666666";

class MemoryStore implements MlsDeviceStore {
    state = new Map<string, Uint8Array>();
    outbox: { id: number; message: Uint8Array }[] = [];
    private next = 1;
    async load() {
        const keys = [...this.state.keys()];
        return { keys: keys.map((k) => new Uint8Array(Buffer.from(k, "hex"))), values: keys.map((k) => this.state.get(k) as Uint8Array), outbox: [...this.outbox] };
    }
    async commit(changes: readonly { key: Uint8Array; value?: Uint8Array | null }[], messages: readonly Uint8Array[] = []) {
        for (const { key, value } of changes) {
            const id = Buffer.from(key).toString("hex");
            if (value) this.state.set(id, new Uint8Array(value));
            else this.state.delete(id);
        }
        return messages.map((message) => {
            const id = this.next++;
            this.outbox.push({ id, message });
            return id;
        });
    }
    async sent(id: number) {
        this.outbox = this.outbox.filter((entry) => entry.id !== id);
    }
}

describe.skipIf(!nativeFile)("a device against the route", () => {
    const { MlsMember } = (nativeFile ? createRequire(import.meta.url)(join(nativeDir, nativeFile)) : {}) as { MlsMember: MlsMemberClass };
    const through =
        (userId: string, lose: { afterCommit?: boolean } = {}): MlsTransport =>
        async (body) => {
            const answer = await call(body, userId);
            if (lose.afterCommit && body.op === "commit") {
                lose.afterCommit = false;
                throw new TypeError("network error");
            }
            if (answer.status !== 200) throw new MlsRequestError(answer.status, String(answer.body.error));
            return answer.body;
        };
    type Account = { hpkePublicKey: Uint8Array; hpkePrivateKey: CryptoKey };
    const open = (
        userId: string,
        device: string,
        store = new MemoryStore(),
        notes = new Map<string, string>(),
        transport = through(userId),
        account?: Account,
        historyKeys?: MlsHistoryKeyStore
    ) =>
        MlsDevice.open({
            userId,
            device,
            MlsMember,
            store,
            transport,
            account,
            historyKeys,
            notes: { getItem: (k) => notes.get(k) ?? null, setItem: (k, v) => void notes.set(k, v) }
        });
    const say = (device: MlsDevice, text: string) => device.sendApplication(CHANNEL, new TextEncoder().encode(text));
    const heard = async (device: MlsDevice) => (await device.sync(CHANNEL)).map((m) => `${m.sender.split("/")[1]}: ${new TextDecoder().decode(m.plaintext)}`);

    beforeEach(() => {
        for (const user of [CAROL, DAVE]) state.members.add(`${user}:${CHANNEL}`);
    });

    it("creates the group, adds an account by its key packages, and carries messages both ways", async () => {
        const alice = await open(ALICE, "alice-laptop");
        const bob = await open(BOB, "bob-phone-1");
        await alice.register();
        await bob.register();
        expect(state.tables.mlsKeyPackage?.filter((r) => r.userId === BOB)).toHaveLength(20);
        await bob.register();
        expect(state.tables.mlsKeyPackage?.filter((r) => r.userId === BOB)).toHaveLength(20);
        const groupId = await alice.ensureGroup(CHANNEL);
        expect(await alice.ensureGroup(CHANNEL)).toEqual(groupId);
        expect(await alice.addAccounts(CHANNEL, [BOB])).toEqual([`${BOB}/bob-phone-1`]);
        expect(await heard(bob)).toEqual([]);
        expect(bob.groupOf(CHANNEL)).toEqual(alice.groupOf(CHANNEL));
        await say(alice, "hello bob");
        expect(await heard(bob)).toEqual(["alice-laptop: hello bob"]);
        await say(bob, "hi alice");
        expect(await heard(alice)).toEqual(["bob-phone-1: hi alice"]);
        expect(await heard(alice)).toEqual([]);
    });

    it("loses a commit race without forking: drops its commit, reads the winner's and adds again", async () => {
        const alice = await open(ALICE, "alice-laptop");
        const bob = await open(BOB, "bob-phone-1");
        const carol = await open(CAROL, "carol-desk-1");
        const dave = await open(DAVE, "dave-desk-1");
        for (const device of [alice, bob, carol, dave]) await device.register();
        await alice.ensureGroup(CHANNEL);
        await alice.addAccounts(CHANNEL, [BOB]);
        await bob.sync(CHANNEL);
        await bob.addAccounts(CHANNEL, [CAROL]);
        // alice has not read bob's commit: her add for epoch 1 loses, and the retry is for epoch 2.
        expect(await alice.addAccounts(CHANNEL, [DAVE])).toEqual([`${DAVE}/dave-desk-1`]);
        for (const device of [bob, carol, dave]) await device.sync(CHANNEL);
        await say(dave, "made it");
        expect(await heard(alice)).toEqual(["dave-desk-1: made it"]);
        expect(await heard(carol)).toEqual(["dave-desk-1: made it"]);
        expect(((await call({ op: "group", channelId: CHANNEL })).body.group as { epoch: string }).epoch).toBe("3");
    });

    it("finishes a commit the server took after a restart that never heard the answer", async () => {
        const store = new MemoryStore();
        const notes = new Map<string, string>();
        const lose = { afterCommit: true };
        const alice = await open(ALICE, "alice-laptop", store, notes, through(ALICE, lose));
        const bob = await open(BOB, "bob-phone-1");
        await alice.register();
        await bob.register();
        await alice.ensureGroup(CHANNEL);
        await expect(alice.addAccounts(CHANNEL, [BOB])).rejects.toThrow("network error");
        expect(store.outbox).toHaveLength(1);
        const restarted = await open(ALICE, "alice-laptop", store, notes);
        expect(store.outbox).toHaveLength(0);
        await bob.sync(CHANNEL);
        await say(restarted, "after the restart");
        expect(await heard(bob)).toEqual(["alice-laptop: after the restart"]);
    });

    it("joins again from the GroupInfo when the device lost its store, and two creators end in one group", async () => {
        const notes = new Map<string, string>();
        const alice = await open(ALICE, "alice-laptop");
        const bob = await open(BOB, "bob-phone-1", new MemoryStore(), notes);
        await Promise.all([alice.register(), bob.register()]);
        const [mine, theirs] = await Promise.all([alice.ensureGroup(CHANNEL), bob.ensureGroup(CHANNEL)]);
        expect(theirs).toEqual(mine);
        await say(bob, "joined by myself");
        expect(await heard(alice)).toEqual(["bob-phone-1: joined by myself"]);

        const fresh = await open(BOB, "bob-phone-1", new MemoryStore(), notes);
        await fresh.register();
        expect(await fresh.ensureGroup(CHANNEL)).toEqual(mine);
        await say(alice, "still here");
        expect(await heard(fresh)).toEqual(["alice-laptop: still here"]);
        await say(fresh, "back again");
        expect(await heard(alice)).toEqual(["bob-phone-1: back again"]);
    });
    const epochNow = async () => ((await call({ op: "group", channelId: CHANNEL })).body.group as { epoch: string }).epoch;

    it("rejoins after losing the store it joined by Welcome with, and removes its old leaf", async () => {
        const alice = await open(ALICE, "alice-laptop");
        const lost = await open(BOB, "bob-phone-1");
        await Promise.all([alice.register(), lost.register()]);
        await alice.ensureGroup(CHANNEL);
        await alice.addAccounts(CHANNEL, [BOB]);
        await say(alice, "before");
        expect(await heard(lost)).toEqual(["alice-laptop: before"]);

        // Same address, new key: the Welcome in the log is for a key it no longer holds.
        const fresh = await open(BOB, "bob-phone-1");
        await fresh.register();
        expect(await fresh.ensureGroup(CHANNEL)).toEqual(alice.groupOf(CHANNEL));
        // create 0, add 1, external join 2, removal of the old leaf 3.
        expect(await epochNow()).toBe("3");
        await say(alice, "after");
        expect(await heard(fresh)).toEqual(["alice-laptop: after"]);
        await say(fresh, "back");
        expect(await heard(alice)).toEqual(["bob-phone-1: back"]);
        // The old copy reads its own removal and lets the group go.
        expect(await heard(lost)).toEqual([]);
        expect(lost.groupOf(CHANNEL)).toBeNull();
    });

    it("removes every device of an account that left; the removed device forgets the group and cannot rejoin", async () => {
        const alice = await open(ALICE, "alice-laptop");
        const bob = await open(BOB, "bob-phone-1");
        const carol = await open(CAROL, "carol-desk-1");
        for (const device of [alice, bob, carol]) await device.register();
        await alice.ensureGroup(CHANNEL);
        await alice.addAccounts(CHANNEL, [BOB, CAROL]);
        await Promise.all([bob.sync(CHANNEL), carol.sync(CHANNEL)]);
        expect(await alice.removeAccounts(CHANNEL, [BOB])).toEqual([`${BOB}/bob-phone-1`]);
        expect(await alice.removeAccounts(CHANNEL, [BOB])).toEqual([]);
        state.members.delete(`${BOB}:${CHANNEL}`);
        await say(alice, "bob is gone");
        expect(await heard(carol)).toEqual(["alice-laptop: bob is gone"]);
        state.members.add(`${BOB}:${CHANNEL}`);
        expect(await heard(bob)).toEqual([]);
        expect(bob.groupOf(CHANNEL)).toBeNull();
        state.members.delete(`${BOB}:${CHANNEL}`);
        await expect(bob.ensureGroup(CHANNEL)).rejects.toMatchObject({ status: 403 });
    });

    it("forgets an external join that lost the epoch race and joins again from the newer GroupInfo", async () => {
        const alice = await open(ALICE, "alice-laptop");
        const bob = await open(BOB, "bob-phone-1");
        const dave = await open(DAVE, "dave-desk-1");
        for (const device of [alice, bob, dave]) await device.register();
        await alice.ensureGroup(CHANNEL);
        await alice.addAccounts(CHANNEL, [BOB]);
        let raced = 0;
        const racing: MlsTransport = async (body) => {
            // alice commits epoch 1 while carol's external commit for it is on the way.
            if (body.op === "commit" && raced++ === 0) await alice.addAccounts(CHANNEL, [DAVE]);
            return through(CAROL)(body);
        };
        const carol = await open(CAROL, "carol-desk-1", new MemoryStore(), new Map(), racing);
        await carol.register();
        expect(await carol.ensureGroup(CHANNEL)).toEqual(alice.groupOf(CHANNEL));
        expect(raced).toBe(2);
        expect(await epochNow()).toBe("3");
        await say(carol, "in after a lost race");
        for (const device of [alice, bob, dave]) expect(await heard(device)).toEqual(["carol-desk-1: in after a lost race"]);
    });

    it("gives each new epoch a history key: in the group, and sealed to the accounts for their next device", async () => {
        // An account key published for alice and bob (as account-keys serves it), none for carol.
        const unlocked = async (userId: string): Promise<Account> => {
            const ak = accountKeys.generateAccountKey();
            const { signPublicKey, hpkePublicKey } = await accountKeys.accountPublicKeys(ak);
            (state.tables.chatAccountKey ??= []).push({ userId, akVersion: 1, signPublicKey: Buffer.from(signPublicKey), hpkePublicKey: Buffer.from(hpkePublicKey) });
            return { hpkePublicKey, hpkePrivateKey: (await accountKeys.accountHpkeKeyPair(ak)).privateKey };
        };
        const [aliceKey, bobKey] = [await unlocked(ALICE), await unlocked(BOB)];
        const alice = await open(ALICE, "alice-laptop", new MemoryStore(), new Map(), through(ALICE), aliceKey);
        // bob's phone has not unlocked the account key: it reads the key in the group, seals nothing.
        const bob = await open(BOB, "bob-phone-1");
        const carol = await open(CAROL, "carol-desk-1");
        for (const device of [alice, bob, carol]) await device.register();
        await alice.ensureGroup(CHANNEL);
        await alice.addAccounts(CHANNEL, [BOB, CAROL]);
        await say(alice, "keyed");
        expect(await heard(bob)).toEqual(["alice-laptop: keyed"]);
        await carol.sync(CHANNEL);
        const epochOne = await alice.historyKey(CHANNEL, 1n);
        expect(epochOne).toHaveLength(32);
        expect(await bob.historyKey(CHANNEL, 1n)).toEqual(epochOne);
        expect(await carol.historyKey(CHANNEL, 1n)).toEqual(epochOne);
        expect(await alice.historyKey(CHANNEL, 0n)).not.toEqual(epochOne);
        const sealed = (state.tables.chatHistoryKey ?? []).map((r) => `${r.epoch}:${r.recipient === ALICE ? "alice" : r.recipient === BOB ? "bob" : "other"}`);
        // Carol has no account key, so nothing is sealed to her; the organisation key is not built.
        // Bob, a member before he had a device in the group, gets epoch 0 as well.
        expect(sealed.sort()).toEqual(["0:alice", "0:bob", "1:alice", "1:bob"]);

        // bob's next device, account key unlocked, opens epoch 1 from the envelope.
        const laptop = await open(BOB, "bob-laptop", new MemoryStore(), new Map(), through(BOB), bobKey);
        expect(await laptop.historyKey(CHANNEL, 1n)).toEqual(epochOne);
        // Epoch 0 was sealed to bob as a member before his first device joined.
        expect(await laptop.historyKey(CHANNEL, 0n)).toEqual(await alice.historyKey(CHANNEL, 0n));
        const stranger = await open(BOB, "bob-tablet", new MemoryStore(), new Map(), through(BOB), await unlocked(EVE));
        await expect(stranger.historyKey(CHANNEL, 1n)).rejects.toThrow();
    });

    it("keeps the history keys it read across a restart, with its account key locked", async () => {
        const alice = await open(ALICE, "alice-laptop");
        const [store, notes] = [new MemoryStore(), new Map<string, string>()];
        const bob = await open(BOB, "bob-phone-1", store, notes, through(BOB), undefined, await IndexedDbHistoryKeyStore.open("bob-phone-1"));
        for (const device of [alice, bob]) await device.register();
        await alice.ensureGroup(CHANNEL);
        await alice.addAccounts(CHANNEL, [BOB]);
        await bob.sync(CHANNEL);
        const epochOne = await alice.historyKey(CHANNEL, 1n);
        expect(await bob.historyKey(CHANNEL, 1n)).toEqual(epochOne);
        // Restarted: a new run over the same store, no account key, nothing held in memory.
        const restarted = await open(BOB, "bob-phone-1", store, notes, through(BOB), undefined, await IndexedDbHistoryKeyStore.open("bob-phone-1"));
        expect(await restarted.historyKey(CHANNEL, 1n)).toEqual(epochOne);
        // Without the store the restart has lost it (no account key to open an envelope with).
        const forgetful = await open(BOB, "bob-phone-1", store, notes, through(BOB));
        expect(await forgetful.historyKey(CHANNEL, 1n)).toBeNull();
    });

    it("seals a message under the epoch's history key, signed by the device, and only a member opens it", async () => {
        const alice = await open(ALICE, "alice-laptop");
        const bob = await open(BOB, "bob-phone-1");
        for (const device of [alice, bob]) await device.register();
        await alice.ensureGroup(CHANNEL);
        await alice.addAccounts(CHANNEL, [BOB]);
        await bob.sync(CHANNEL);
        const clientKey = crypto.randomUUID();
        const id = await alice.sendSealed(CHANNEL, new TextEncoder().encode("only for us"), { clientKey });
        // A retry of the same send is the same message.
        expect(await alice.sendSealed(CHANNEL, new TextEncoder().encode("only for us"), { clientKey })).toBe(id);
        const row = state.tables.chatMessage!.find((r) => r.id === id)!;
        expect(row.body).toBe("");
        expect(Buffer.from(row.e2eeCiphertext as Uint8Array).includes(Buffer.from("only for us"))).toBe(false);
        expect(Buffer.from(row.e2eeSignatureKey as Uint8Array)).toEqual(Buffer.from(state.tables.mlsDevice!.find((d) => d.userId === ALICE)!.signatureKey as Uint8Array));
        const [read] = await bob.readSealed(CHANNEL, [id]);
        expect(new TextDecoder().decode(read!.opened!)).toBe("only for us");
        expect(read!.sender).toBe(`${ALICE}/alice-laptop`);
        // An answer keeps who it answers as metadata, the way a plain reply does.
        const answer = await bob.sendSealed(CHANNEL, new TextEncoder().encode("same here"), { replyToId: id });
        expect(state.tables.chatMessage!.find((r) => r.id === answer)).toMatchObject({ body: "", replyToId: id, authorId: BOB });

        // Changed at rest: the signature no longer covers it, and nothing is opened.
        const ciphertext = new Uint8Array(row.e2eeCiphertext as Uint8Array);
        ciphertext[5] ^= 1;
        row.e2eeCiphertext = ciphertext;
        expect((await bob.readSealed(CHANNEL, [id]))[0]!.opened).toBeNull();

        // A device without the history key gets nothing; a deleted message is not served.
        const late = await open(CAROL, "carol-desk-1");
        state.members.add(`${CAROL}:${CHANNEL}`);
        expect((await late.readSealed(CHANNEL, [id]))[0]!.opened).toBeNull();
        row.deletedAt = new Date();
        expect(await bob.readSealed(CHANNEL, [id])).toEqual([]);
    });

    it("refuses a sealed message with another device's signature, from a future epoch, or from a device not its own", async () => {
        const alice = await open(ALICE, "alice-laptop");
        await alice.register();
        await alice.ensureGroup(CHANNEL);
        const send = (overrides: Record<string, unknown>, as = ALICE) =>
            call(
                {
                    op: "send-sealed",
                    channelId: CHANNEL,
                    device: "alice-laptop",
                    clientKey: crypto.randomUUID(),
                    epoch: "0",
                    senderLeaf: 0,
                    ciphertext: Buffer.alloc(40, 1).toString("base64url"),
                    signature: Buffer.alloc(64, 2).toString("base64url"),
                    ...overrides
                },
                as
            );
        expect(await send({})).toMatchObject({ status: 409, body: { error: "badSignature" } });
        expect(await send({ epoch: "9" })).toMatchObject({ status: 409, body: { error: "futureEpoch" } });
        expect(await send({}, BOB)).toMatchObject({ status: 409, body: { error: "unknownDevice" } });
        expect(state.tables.chatMessage ?? []).toEqual([]);
    });

    it("seals each epoch's history key to dormant members too, and to nobody outside the conversation", async () => {
        const unlocked = async (userId: string): Promise<Account> => {
            const ak = accountKeys.generateAccountKey();
            const { signPublicKey, hpkePublicKey } = await accountKeys.accountPublicKeys(ak);
            (state.tables.chatAccountKey ??= []).push({ userId, akVersion: 1, signPublicKey: Buffer.from(signPublicKey), hpkePublicKey: Buffer.from(hpkePublicKey) });
            return { hpkePublicKey, hpkePrivateKey: (await accountKeys.accountHpkeKeyPair(ak)).privateKey };
        };
        const [aliceKey, daveKey] = [await unlocked(ALICE), await unlocked(DAVE)];
        await unlocked(EVE);
        const alice = await open(ALICE, "alice-laptop", new MemoryStore(), new Map(), through(ALICE), aliceKey);
        const bob = await open(BOB, "bob-phone-1");
        for (const device of [alice, bob]) await device.register();
        await alice.ensureGroup(CHANNEL);
        await alice.addAccounts(CHANNEL, [BOB]);
        const epochOne = await alice.historyKey(CHANNEL, 1n);
        const recipients = (state.tables.chatHistoryKey ?? []).filter((r) => r.epoch === 1n).map((r) => r.recipient);
        // Dave is in the conversation with no device anywhere; Eve has a key but is not in it.
        expect(recipients).toContain(DAVE);
        expect(recipients).not.toContain(EVE);
        // Dave's first device opens the epoch from his envelope.
        const daveFirst = await open(DAVE, "dave-desk-1", new MemoryStore(), new Map(), through(DAVE), daveKey);
        expect(await daveFirst.historyKey(CHANNEL, 1n)).toEqual(epochOne);
    });
});
