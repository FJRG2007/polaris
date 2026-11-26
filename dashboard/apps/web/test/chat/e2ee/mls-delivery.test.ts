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
    seq: 0n,
    keepEditHistory: true,
    editWindowMinutes: null as number | null,
    deviceNotices: [] as string[]
}));

vi.mock("@/lib/session", () => ({ backgroundUser: async () => state.user }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/notifications/security-events", () => ({
    notifySealedDeviceAdded: async (userId: string) => void state.deviceNotices.push(userId)
}));
// The ordinary send, reduced to the row it writes: what a sealed message adds to it is under test here.
vi.mock("@/lib/chat/messages", () => ({
    send: async (actor: { id: string }, input: { channelId: string; body: string; clientKey?: string }, ...rest: unknown[]) => {
        const rows = (state.tables.chatMessage ??= []);
        const earlier = rows.find((r) => r.authorId === actor.id && r.clientKey === input.clientKey);
        if (earlier) return earlier.id;
        const id = crypto.randomUUID();
        rows.push({ id, channelId: input.channelId, authorId: actor.id, clientKey: input.clientKey, body: input.body, deletedAt: null, expiresAt: null, audience: [], createdAt: new Date(), editedAt: null, replyToId: (rest[1] as { messageId?: string } | null)?.messageId ?? null, ...(rest[5] as Row) });
        return id;
    },
    // The checks every edit makes, reduced to the ones a sealed edit is tested against here.
    requireRewritable: async (actor: { id: string }, messageId: string) => {
        const refuse = (key: string) => Object.assign(new Error(key), { name: "ChatRuleError", textIn: () => key });
        const message = (state.tables.chatMessage ?? []).find((r) => r.id === messageId);
        if (!message) throw refuse("errors.messageGone");
        if (message.authorId !== actor.id) throw refuse("errors.editOwnOnly");
        if (message.deletedAt) throw refuse("errors.messageDeleted");
        if (state.editWindowMinutes !== null && Date.now() - (message.createdAt as Date).getTime() > state.editWindowMinutes * 60_000) throw refuse("errors.editWindowPassed");
        return { message, rules: { keepEditHistory: state.keepEditHistory } };
    }
}));
vi.mock("@/lib/chat/access", () => ({
    channelAccess: async (actor: { id: string }, channelId: string) => (state.members.has(`${actor.id}:${channelId}`) ? { id: channelId } : null),
    conversationAudience: async (actor: { id: string }, channelId: string) =>
        state.members.has(`${actor.id}:${channelId}`)
            ? [...state.members].filter((m) => m.endsWith(`:${channelId}`)).map((m) => m.slice(0, m.indexOf(":")))
            : null
}));

vi.mock("@polaris/db", async () => ({ prisma: (await import("./support/mls-tables")).memoryPrisma(state), Prisma: { DbNull: null } }));

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

async function call(body: unknown, as: string | null = ALICE, userAgent?: string) {
    state.user = as ? { id: as } : null;
    const headers: Record<string, string> = { "content-type": "application/json", ...(userAgent ? { "user-agent": userAgent } : {}) };
    const response = await handleMls(new Request("http://x/api/e2ee/mls", { method: "POST", headers, body: JSON.stringify(body) }));
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
    state.keepEditHistory = true;
    state.editWindowMinutes = null;
    state.deviceNotices = [];
});

describe("/api/e2ee/mls", () => {
    it("does not exist with the flag off, and needs a session and JSON", async () => {
        delete process.env.POLARIS_INTERNAL_CHAT_E2EE;
        expect((await call({ op: "group", channelId: CHANNEL })).status).toBe(404);
        process.env.POLARIS_INTERNAL_CHAT_E2EE = "1";
        expect((await call({ op: "group", channelId: CHANNEL }, null)).status).toBe(401);
        expect((await call({ op: "group", channelId: "not-a-uuid" })).status).toBe(400);
        const plain = await handleMls(new Request("http://x", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }));
        expect(plain.status).toBe(400);
    });

    it("held by the kill switch: no new group, and a sealed conversation keeps every op", async () => {
        await device(ALICE, "alice-laptop");
        process.env.POLARIS_INTERNAL_CHAT_E2EE = "0";
        expect((await call({ op: "group", channelId: CHANNEL })).body).toEqual({ sealed: false, group: null });
        const refused = await call({ op: "create-group", channelId: CHANNEL, groupId: blob(1, 16), ciphersuite: 0x004f, groupInfo: blob(2) });
        expect(refused).toEqual({ status: 409, body: { error: "held" } });
        process.env.POLARIS_INTERNAL_CHAT_E2EE = "1";
        expect((await call({ op: "create-group", channelId: CHANNEL, groupId: blob(1, 16), ciphersuite: 0x004f, groupInfo: blob(2) })).status).toBe(200);
        process.env.POLARIS_INTERNAL_CHAT_E2EE = "0";
        const group = await call({ op: "group", channelId: CHANNEL });
        expect(group.status).toBe(200);
        expect(group.body).toMatchObject({ sealed: true, group: { epoch: "0" } });
        expect((await call({ op: "events", channelId: CHANNEL, device: "alice-laptop", after: "0" })).status).toBe(200);
    });

    it("held: a conversation the migration cut still gets its group", async () => {
        await device(ALICE, "alice-laptop");
        state.tables.chatMigration = [{ channelId: CHANNEL, state: "cut" }];
        process.env.POLARIS_INTERNAL_CHAT_E2EE = "0";
        expect((await call({ op: "group", channelId: CHANNEL })).body).toEqual({ sealed: true, group: null });
        expect((await call({ op: "create-group", channelId: CHANNEL, groupId: blob(1, 16), ciphersuite: 0x004f, groupInfo: blob(2) })).status).toBe(200);
    });

    it("tells a Polaris app too old for sealed chat to update, and gives it no device", async () => {
        const oldAndroid = "Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36 PolarisMobile/0.1.14 (Android)";
        const refused = await call({ op: "register-device", device: "old-phone", signatureKey: blob(7, 32), e2eeVersion: 1 }, ALICE, oldAndroid);
        expect(refused).toEqual({ status: 426, body: { error: "updateApp", app: "android", minimum: "0.1.15" } });
        expect(state.tables.mlsDevice ?? []).toHaveLength(0);
        const current = oldAndroid.replace("0.1.14", "0.1.15");
        expect((await call({ op: "register-device", device: "new-phone", signatureKey: blob(7, 32), e2eeVersion: 1 }, ALICE, current)).status).toBe(200);
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

    it("keeps a large group's tree in parts: staged before the commit, promoted by it, served, and pruned", async () => {
        await device(ALICE, "alice-laptop");
        await device(BOB, "bob-phone-1");
        await call({ op: "create-group", channelId: CHANNEL, groupId: blob(1, 16), ciphersuite: 0x004f, groupInfo: blob(2) });
        const put = (epoch: string, part: number, parts: number, fill: number, as = ALICE, name = "alice-laptop") =>
            call({ op: "put-tree-part", channelId: CHANNEL, device: name, epoch, part, parts, bytes: blob(fill, 64) }, as);
        const commit = (epoch: string, treeParts?: number) =>
            call({ op: "commit", channelId: CHANNEL, device: "alice-laptop", epoch, commit: blob(10), groupInfo: blob(11), ...(treeParts ? { treeParts } : {}) });
        const tree = (epoch: string, part = 0, as = ALICE) => call({ op: "ratchet-tree", channelId: CHANNEL, epoch, part }, as);

        // Only for the epoch the next commit moves into, by the session's own device, with the part inside the count.
        expect((await put("0", 0, 2, 1)).body.error).toBe("staleEpoch");
        expect((await put("2", 0, 2, 1)).body.error).toBe("staleEpoch");
        expect((await put("1", 2, 2, 1)).body.error).toBe("treeMissing");
        expect((await put("1", 0, 2, 1, BOB, "alice-laptop")).status).toBe(403);
        expect((await call({ op: "put-tree-part", channelId: CHANNEL, device: "alice-laptop", epoch: "1", part: 0, parts: 65, bytes: blob(1) })).status).toBe(400);

        // A commit naming more parts than were staged is refused whole: the epoch does not move.
        expect((await put("1", 0, 2, 1)).status).toBe(200);
        expect((await commit("0", 2)).body.error).toBe("treeMissing");
        expect(((await call({ op: "group", channelId: CHANNEL })).body.group as { epoch: string }).epoch).toBe("0");
        // Staged is not served.
        expect((await tree("1")).status).toBe(404);

        // A retry overwrites its own part; another device's staged copy is dropped by the commit that wins.
        expect((await put("1", 0, 2, 3)).status).toBe(200);
        expect((await put("1", 1, 2, 4)).status).toBe(200);
        expect((await put("1", 0, 1, 9, BOB, "bob-phone-1")).status).toBe(200);
        expect((await commit("0", 2)).status).toBe(200);
        expect(state.tables.mlsTreePart).toHaveLength(2);
        expect((await tree("1", 0)).body).toEqual({ parts: 2, bytes: blob(3, 64) });
        expect((await tree("1", 1, BOB)).body).toEqual({ parts: 2, bytes: blob(4, 64) });
        expect((await tree("1", 0, EVE)).status).toBe(403);
        const group = (await call({ op: "group", channelId: CHANNEL })).body.group as { epoch: string; treeParts: number | null };
        expect(group).toMatchObject({ epoch: "1", treeParts: 2 });

        // A commit with the tree inline (a small group again, an older device) leaves the group's latest tree unnamed.
        expect((await commit("1")).status).toBe(200);
        expect(((await call({ op: "group", channelId: CHANNEL })).body.group as { treeParts: number | null }).treeParts).toBeNull();
        // The tree a Welcome of epoch 1 needs is kept for a few epochs, then pruned.
        expect((await tree("1")).status).toBe(200);
        for (let epoch = 2; epoch < 5; epoch++) expect((await commit(String(epoch))).status).toBe(200);
        expect((await tree("1")).status).toBe(404);
        expect(state.tables.mlsTreePart).toHaveLength(0);
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

    it("adds at most one claim's worth of newcomers per send, however many the roster answers", async () => {
        // A large channel: the roster's pages together name more joinable accounts than one claim takes.
        const many = Array.from({ length: 150 }, (_, i) => `66666666-6666-4666-8666-${String(i).padStart(12, "0")}`);
        const claims: number[] = [];
        const wide: MlsTransport = async (body) => {
            if (body.op === "claim-key-packages") claims.push(body.userIds.length);
            const answer = await through(ALICE)(body);
            return body.op === "roster" ? { ...answer, joinable: [...(answer.joinable as string[]), ...many] } : answer;
        };
        const alice = await open(ALICE, "alice-laptop", undefined, undefined, wide);
        const carol = await open(CAROL, "carol-desk-1");
        for (const device of [alice, carol]) await device.register();
        await alice.ensureGroup(CHANNEL);
        state.members.add(`${CAROL}:${CHANNEL}`);
        // Members of the conversation, with no device yet: the claim answers no packages for them.
        for (const id of many) state.members.add(`${id}:${CHANNEL}`);

        await alice.sendSealed(CHANNEL, new TextEncoder().encode("to a big room"));
        expect(claims.length).toBeGreaterThan(0);
        expect(Math.max(...claims)).toBeLessThanOrEqual(100);
        // Carol was in the batch, so she reads it without having opened the conversation.
        await carol.sync(CHANNEL);
        expect(carol.groupOf(CHANNEL)).toEqual(alice.groupOf(CHANNEL));
    });

    it("takes out a crowd that left in several small commits, all of them before the message is sealed", async () => {
        const crowd = Array.from({ length: 5 }, (_, i) => `77777777-7777-4777-8777-${String(i).padStart(12, "0")}`);
        const sizes: number[] = [];
        const measured: MlsTransport = async (body) => {
            if (body.op === "commit") sizes.push(Buffer.from(body.commit, "base64url").length);
            return through(ALICE)(body);
        };
        const notes = new Map<string, string>();
        const alice = await MlsDevice.open({
            userId: ALICE,
            device: "alice-laptop",
            MlsMember,
            store: new MemoryStore(),
            transport: measured,
            batch: { remove: 2 },
            notes: { getItem: (k) => notes.get(k) ?? null, setItem: (k, v) => void notes.set(k, v) }
        });
        const others = await Promise.all(crowd.map((id, i) => open(id, `crowd-device-${i}`)));
        for (const device of [alice, ...others]) await device.register();
        for (const id of crowd) state.members.add(`${id}:${CHANNEL}`);
        await alice.ensureGroup(CHANNEL);
        await alice.addAccounts(CHANNEL, crowd);
        for (const device of others) await device.sync(CHANNEL);

        // The whole crowd leaves at once; a batch of two takes three commits.
        for (const id of crowd) state.members.delete(`${id}:${CHANNEL}`);
        sizes.length = 0;
        const id = await alice.sendSealed(CHANNEL, new TextEncoder().encode("after the crowd left"));
        expect(sizes).toHaveLength(3);
        for (const size of sizes) expect(size).toBeLessThan(64 * 1024);
        expect(alice.groupOf(CHANNEL)).not.toBeNull();

        // None of them opens what was sealed after they left, even served the row.
        for (const [i, device] of others.entries()) {
            state.members.add(`${crowd[i]}:${CHANNEL}`);
            await device.sync(CHANNEL);
            expect(device.groupOf(CHANNEL)).toBeNull();
            expect((await device.readSealed(CHANNEL, [id]))[0]!.opened).toBeNull();
            state.members.delete(`${crowd[i]}:${CHANNEL}`);
        }
    });

    it("before sealing, takes out the devices of who left and adds the people who joined", async () => {
        const alice = await open(ALICE, "alice-laptop");
        const bob = await open(BOB, "bob-phone-1");
        const carol = await open(CAROL, "carol-desk-1");
        for (const device of [alice, bob, carol]) await device.register();
        await alice.ensureGroup(CHANNEL);
        await alice.addAccounts(CHANNEL, [BOB]);
        await bob.sync(CHANNEL);
        const commits = () => state.tables.mlsGroupEvent!.filter((e) => e.kind === "commit").length;

        // Bob leaves; Carol, with a device, is in the conversation but holds no leaf.
        state.members.delete(`${BOB}:${CHANNEL}`);
        const before = commits();
        const id = await alice.sendSealed(CHANNEL, new TextEncoder().encode("after bob left"));
        expect(commits()).toBe(before + 2);

        // Carol reads it without ever having opened the conversation herself.
        expect(carol.groupOf(CHANNEL)).toBeNull();
        await carol.sync(CHANNEL);
        expect(carol.groupOf(CHANNEL)).toEqual(alice.groupOf(CHANNEL));
        const [read] = await carol.readSealed(CHANNEL, [id]);
        expect(new TextDecoder().decode(read!.opened!)).toBe("after bob left");

        // Bob's device was taken out before the message was sealed: even served the row, it cannot open it.
        state.members.add(`${BOB}:${CHANNEL}`);
        expect(await heard(bob)).toEqual([]);
        expect(bob.groupOf(CHANNEL)).toBeNull();
        expect((await bob.readSealed(CHANNEL, [id]))[0]!.opened).toBeNull();
        state.members.delete(`${BOB}:${CHANNEL}`);

        // Nothing changed since: the next message commits nothing.
        const settled = commits();
        await alice.sendSealed(CHANNEL, new TextEncoder().encode("again"));
        expect(commits()).toBe(settled);
    });

    it("before sealing, takes out the leaves of retired devices, the account's own other browsers included", async () => {
        const alice = await open(ALICE, "alice-laptop");
        const aliceOld = await open(ALICE, "alice-old-pc");
        const bob = await open(BOB, "bob-phone-1");
        const bobLost = await open(BOB, "bob-phone-2");
        for (const device of [alice, aliceOld, bob, bobLost]) await device.register();
        await alice.ensureGroup(CHANNEL);
        await alice.addAccounts(CHANNEL, [BOB]);
        for (const device of [bob, bobLost]) await device.sync(CHANNEL);
        await aliceOld.ensureGroup(CHANNEL);
        for (const device of [alice, bob, bobLost]) await device.sync(CHANNEL);
        expect(bobLost.groupOf(CHANNEL)).toEqual(alice.groupOf(CHANNEL));
        expect(aliceOld.groupOf(CHANNEL)).toEqual(alice.groupOf(CHANNEL));

        // Bob signs his lost phone out from it; Alice's old PC has not been seen for 31 days.
        await bobLost.retire();
        state.tables.mlsDevice!.find((d) => d.device === "alice-old-pc")!.lastSeenAt = new Date(Date.now() - 31 * 86_400_000);
        const id = await alice.sendSealed(CHANNEL, new TextEncoder().encode("after the cleanup"));

        // Bob's other phone opens it.
        await bob.sync(CHANNEL);
        expect(new TextDecoder().decode((await bob.readSealed(CHANNEL, [id]))[0]!.opened!)).toBe("after the cleanup");
        // The old PC, served the log and the row, reads its own removal and cannot open it.
        state.tables.mlsDevice!.find((d) => d.device === "alice-old-pc")!.lastSeenAt = new Date();
        await aliceOld.sync(CHANNEL);
        expect(aliceOld.groupOf(CHANNEL)).toBeNull();

        // Nothing changed since: the next message commits nothing.
        const commits = () => state.tables.mlsGroupEvent!.filter((e) => e.kind === "commit").length;
        const settled = commits();
        await alice.sendSealed(CHANNEL, new TextEncoder().encode("again"));
        expect(commits()).toBe(settled);

        // The old PC is back in use: it rejoins on its own.
        await aliceOld.register();
        await aliceOld.ensureGroup(CHANNEL);
        expect(aliceOld.groupOf(CHANNEL)).toEqual(alice.groupOf(CHANNEL));
    });

    it("edits a sealed message: it opens to the new words, and the old version is kept sealed", async () => {
        const alice = await open(ALICE, "alice-laptop");
        const bob = await open(BOB, "bob-phone-1");
        for (const device of [alice, bob]) await device.register();
        await alice.ensureGroup(CHANNEL);
        await alice.addAccounts(CHANNEL, [BOB]);
        await bob.sync(CHANNEL);
        const id = await alice.sendSealed(CHANNEL, new TextEncoder().encode("first words"));
        const row = state.tables.chatMessage!.find((r) => r.id === id)!;
        const firstCiphertext = Buffer.from(row.e2eeCiphertext as Uint8Array);

        const editedAt = await alice.editSealed(CHANNEL, id, new TextEncoder().encode("second words"));
        expect((row.editedAt as Date).toISOString()).toBe(editedAt);
        expect(row.body).toBe("");
        expect(Buffer.from(row.e2eeCiphertext as Uint8Array).includes(Buffer.from("second words"))).toBe(false);
        const [read] = await bob.readSealed(CHANNEL, [id]);
        expect(new TextDecoder().decode(read!.opened!)).toBe("second words");
        expect(read!.sender).toBe(`${ALICE}/alice-laptop`);

        // The version replaced is kept as it was stored, and opens on a member's device.
        const [kept] = state.tables.chatMessageEdit!;
        expect(kept).toMatchObject({ messageId: id, body: "" });
        expect(Buffer.from(kept!.e2eeCiphertext as Uint8Array)).toEqual(firstCiphertext);
        const text = (value: unknown) => Buffer.from(value as Uint8Array).toString("base64url");
        const version = {
            clientKey: row.clientKey as string,
            device: kept!.e2eeDevice as string,
            epoch: String(kept!.e2eeEpoch),
            senderLeaf: kept!.e2eeSenderLeaf as number,
            revision: (kept!.e2eeRevision as number | null) ?? 0,
            ciphertext: text(kept!.e2eeCiphertext),
            signature: text(kept!.e2eeSignature),
            signatureKey: text(kept!.e2eeSignatureKey)
        };
        expect(version.revision).toBe(0);
        expect(row.e2eeRevision).toBe(1);
        expect((await bob.openVersions(CHANNEL, id, [version])).map((v) => v && new TextDecoder().decode(v))).toEqual(["first words"]);
        // Taken out of its place, it does not open as another message or as another revision.
        expect(await bob.openVersions(CHANNEL, id, [{ ...version, clientKey: crypto.randomUUID() }])).toEqual([null]);
        expect(await bob.openVersions(CHANNEL, id, [{ ...version, revision: 1 }])).toEqual([null]);

        // Where history is not kept, nothing earlier is written.
        state.keepEditHistory = false;
        await alice.editSealed(CHANNEL, id, new TextEncoder().encode("third words"));
        expect(state.tables.chatMessageEdit).toHaveLength(1);
        expect(new TextDecoder().decode((await bob.readSealed(CHANNEL, [id]))[0]!.opened!)).toBe("third words");
    });

    it("never shows an earlier version as the latest: the revision is signed, and a device keeps the highest it saw", async () => {
        const alice = await open(ALICE, "alice-laptop");
        const bob = await open(BOB, "bob-phone-1");
        for (const device of [alice, bob]) await device.register();
        await alice.ensureGroup(CHANNEL);
        await alice.addAccounts(CHANNEL, [BOB]);
        await bob.sync(CHANNEL);
        const id = await alice.sendSealed(CHANNEL, new TextEncoder().encode("v0"));
        await alice.editSealed(CHANNEL, id, new TextEncoder().encode("v1"));
        await alice.editSealed(CHANNEL, id, new TextEncoder().encode("v2"));
        const row = state.tables.chatMessage!.find((r) => r.id === id)!;
        expect(row.e2eeRevision).toBe(2);
        const columns = ["e2eeCiphertext", "e2eeEpoch", "e2eeSenderLeaf", "e2eeDevice", "e2eeSignature", "e2eeSignatureKey", "e2eeRevision"] as const;
        const latest = Object.fromEntries(columns.map((c) => [c, row[c]]));
        const opened = async (device: typeof bob) => {
            const [read] = await device.readSealed(CHANNEL, [id]);
            return read!.opened && new TextDecoder().decode(read!.opened);
        };

        // The latest version relabelled as an earlier revision does not verify, even for a device that saw nothing yet.
        row.e2eeRevision = 1;
        expect(await opened(bob)).toBeNull();
        Object.assign(row, latest);
        expect(await opened(bob)).toBe("v2");

        // The server swaps in the version before it, as it was signed: both devices refuse it.
        const [, previous] = state.tables.chatMessageEdit!;
        expect(previous!.e2eeRevision).toBe(1);
        Object.assign(row, Object.fromEntries(columns.map((c) => [c, previous![c]])));
        expect(await opened(bob)).toBeNull();
        expect(await opened(alice)).toBeNull();
        expect((await bob.readSealed(CHANNEL, [id]))[0]!.revision).toBe(1);
        // Nor does the author edit over it.
        await expect(alice.editSealed(CHANNEL, id, new TextEncoder().encode("over old"))).rejects.toMatchObject({ reason: "staleRevision" });
        Object.assign(row, latest);
        expect(await opened(bob)).toBe("v2");

        // Two edits racing: one lands, the other is sealed again over it as the next revision.
        await Promise.all([alice.editSealed(CHANNEL, id, new TextEncoder().encode("left")), alice.editSealed(CHANNEL, id, new TextEncoder().encode("right"))]);
        // A refused transaction puts back a copy of the tables, so the row is looked up again.
        expect(state.tables.chatMessage!.find((r) => r.id === id)!.e2eeRevision).toBe(4);
        expect(["left", "right"]).toContain(await opened(bob));
        expect(state.tables.chatMessageEdit!.map((r) => r.e2eeRevision ?? 0)).toEqual([0, 1, 2, 3]);
    });

    it("refuses a sealed edit of somebody else's message, with another device's signature, under an older epoch, or past the window", async () => {
        const alice = await open(ALICE, "alice-laptop");
        const bob = await open(BOB, "bob-phone-1");
        for (const device of [alice, bob]) await device.register();
        await alice.ensureGroup(CHANNEL);
        await alice.addAccounts(CHANNEL, [BOB]);
        await bob.sync(CHANNEL);
        const id = await alice.sendSealed(CHANNEL, new TextEncoder().encode("mine"));
        const row = state.tables.chatMessage!.find((r) => r.id === id)!;
        const stored = { ciphertext: Buffer.from(row.e2eeCiphertext as Uint8Array), epoch: row.e2eeEpoch };
        const edit = (overrides: Record<string, unknown>, as = ALICE) =>
            call(
                {
                    op: "edit-sealed",
                    channelId: CHANNEL,
                    device: "alice-laptop",
                    messageId: id,
                    epoch: String(row.e2eeEpoch),
                    senderLeaf: 0,
                    revision: 1,
                    ciphertext: Buffer.alloc(40, 1).toString("base64url"),
                    signature: Buffer.alloc(64, 2).toString("base64url"),
                    ...overrides
                },
                as
            );

        await expect(bob.editSealed(CHANNEL, id, new TextEncoder().encode("not yours"))).rejects.toMatchObject({ status: 409 });
        expect(await edit({ device: "bob-phone-1" }, BOB)).toMatchObject({ status: 409, body: { error: "refused", text: "errors.editOwnOnly" } });
        expect(await edit({})).toMatchObject({ status: 409, body: { error: "badSignature" } });
        expect(await edit({ epoch: "0" })).toMatchObject({ status: 409, body: { error: "olderEpoch" } });
        expect(await edit({ epoch: "99" })).toMatchObject({ status: 409, body: { error: "futureEpoch" } });
        // Only the next revision: not the one it has, not one past it, and never none.
        expect(await edit({ revision: 2 })).toMatchObject({ status: 409, body: { error: "staleRevision" } });
        expect(await edit({ revision: 0 })).toMatchObject({ status: 400 });
        expect(await edit({ revision: undefined })).toMatchObject({ status: 400 });
        // A plain message is not edited sealed.
        state.tables.chatMessage!.push({ id: crypto.randomUUID(), channelId: CHANNEL, authorId: ALICE, clientKey: crypto.randomUUID(), body: "plain", deletedAt: null, createdAt: new Date(), e2eeEpoch: null });
        expect(await edit({ messageId: state.tables.chatMessage!.at(-1)!.id })).toMatchObject({ status: 409, body: { error: "notSealed" } });
        // Past the scope's edit window.
        state.editWindowMinutes = 5;
        row.createdAt = new Date(Date.now() - 10 * 60_000);
        await expect(alice.editSealed(CHANNEL, id, new TextEncoder().encode("too late"))).rejects.toMatchObject({ status: 409 });
        expect(await edit({})).toMatchObject({ status: 409, body: { text: "errors.editWindowPassed" } });

        // Nothing of it landed.
        expect(Buffer.from(row.e2eeCiphertext as Uint8Array)).toEqual(stored.ciphertext);
        expect(row.e2eeEpoch).toBe(stored.epoch);
        expect(row.editedAt).toBeNull();
        expect(state.tables.chatMessageEdit ?? []).toEqual([]);
    });

    it("answers who left and who has no leaf to a member only", async () => {
        await device(CAROL, "carol-desk-1");
        await call({ op: "publish-key-packages", device: "carol-desk-1", ciphersuite: 0x004f, keyPackages: [blob(5)] }, CAROL);
        state.members.delete(`${BOB}:${CHANNEL}`);
        const roster = (accounts: string[], as = ALICE) => call({ op: "roster", channelId: CHANNEL, accounts, ciphersuite: 0x004f }, as);
        // Dave is in the conversation with no device, so there is nothing to add him by.
        expect((await roster([ALICE, BOB])).body).toEqual({ departed: [BOB], joinable: [CAROL], retired: [] });
        expect((await roster([ALICE, CAROL])).body).toEqual({ departed: [], joinable: [], retired: [] });
        expect((await roster([ALICE], BOB)).status).toBe(403);
    });

    it("names the retired devices among a group's leaves: signed out, unseen past the limit, or never known", async () => {
        await device(ALICE, "alice-laptop");
        await device(BOB, "bob-phone-1");
        await device(BOB, "bob-phone-2");
        await device(BOB, "bob-tablet");
        await call({ op: "publish-key-packages", device: "bob-tablet", ciphersuite: 0x004f, keyPackages: [blob(5)] }, BOB);
        const devices = [`${BOB}/bob-phone-1`, `${BOB}/bob-phone-2`, `${BOB}/bob-tablet`, `${BOB}/bob-gone-00`, `${EVE}/eve-laptop`];
        const roster = (as = ALICE) => call({ op: "roster", channelId: CHANNEL, accounts: [ALICE, BOB], devices, ciphersuite: 0x004f }, as);

        // Bob signs one phone out: the server forgets it and its packages, idempotently.
        expect((await call({ op: "retire-device", device: "bob-phone-2" }, BOB)).body).toEqual({ ok: true });
        expect((await call({ op: "retire-device", device: "bob-phone-2" }, BOB)).body).toEqual({ ok: true });
        expect(state.tables.mlsDevice!.some((d) => d.device === "bob-phone-2")).toBe(false);
        // Bob's tablet has not been seen for 31 days (the default limit is 30).
        const tablet = state.tables.mlsDevice!.find((d) => d.device === "bob-tablet")!;
        tablet.lastSeenAt = new Date(Date.now() - 31 * 86_400_000);
        // Eve is not named, so nothing is said about her devices.
        expect((await roster()).body.retired).toEqual([`${BOB}/bob-phone-2`, `${BOB}/bob-tablet`, `${BOB}/bob-gone-00`]);

        // The tablet is added to nothing new, and its packages go; it publishes fresh ones when it is back.
        expect((await call({ op: "claim-key-packages", channelId: CHANNEL, userIds: [BOB], ciphersuite: 0x004f })).body.keyPackages).toEqual([]);
        expect(state.tables.mlsKeyPackage!.filter((k) => k.device === "bob-tablet")).toEqual([]);

        // An administrator's limit of 90 days keeps it; one out of range is clamped to 7-90.
        state.tables.setting = [{ key: "chat.e2ee.inactiveDeviceDays", value: "90" }];
        expect((await roster()).body.retired).toEqual([`${BOB}/bob-phone-2`, `${BOB}/bob-gone-00`]);
        state.tables.setting = [{ key: "chat.e2ee.inactiveDeviceDays", value: "1000" }];
        expect((await roster()).body.retired).toEqual([`${BOB}/bob-phone-2`, `${BOB}/bob-gone-00`]);
        state.tables.setting = [{ key: "chat.e2ee.inactiveDeviceDays", value: "1" }];
        tablet.lastSeenAt = new Date(Date.now() - 6 * 86_400_000);
        expect((await roster()).body.retired).toEqual([`${BOB}/bob-phone-2`, `${BOB}/bob-gone-00`]);

        // Coming back registers it again: it is in use from then on.
        state.tables.setting = [];
        tablet.lastSeenAt = new Date(Date.now() - 31 * 86_400_000);
        await device(BOB, "bob-tablet");
        expect((await roster()).body.retired).toEqual([`${BOB}/bob-phone-2`, `${BOB}/bob-gone-00`]);

        // A member the server runs is never retired for being quiet; an older caller that names no devices gets none.
        const polar = "00000000-0000-0000-0000-000000000001";
        const quiet = await call({ op: "roster", channelId: CHANNEL, accounts: [ALICE, BOB, polar], devices: [`${polar}/polar-service`], ciphersuite: 0x004f });
        expect(quiet.body.retired).toEqual([]);
        expect((await call({ op: "roster", channelId: CHANNEL, accounts: [ALICE, BOB], ciphersuite: 0x004f })).body.retired).toEqual([]);
        // Retiring needs a session, and takes only the session's own devices.
        expect((await call({ op: "retire-device", device: "alice-laptop" }, null)).status).toBe(401);
        await call({ op: "retire-device", device: "alice-laptop" }, BOB);
        expect(state.tables.mlsDevice!.some((d) => d.device === "alice-laptop")).toBe(true);
    });

    it("tells the account when a device joins one it already had, never for its first, a refresh or a service member", async () => {
        await device(ALICE, "alice-laptop");
        await device(ALICE, "alice-laptop");
        expect(state.deviceNotices).toEqual([]);
        await device(ALICE, "alice-phone-1");
        expect(state.deviceNotices).toEqual([ALICE]);
        await device(ALICE, "alice-phone-1");
        expect(state.deviceNotices).toEqual([ALICE]);
        // Removed (signed out, or taken off on the sessions page) and back: new again.
        await call({ op: "retire-device", device: "alice-phone-1" });
        await device(ALICE, "alice-phone-1");
        expect(state.deviceNotices).toEqual([ALICE, ALICE]);
        const delivery = await import("@/lib/chat/e2ee/mls-delivery");
        const polar = "00000000-0000-0000-0000-000000000001";
        await delivery.registerDevice(polar, "polar-service-a", new Uint8Array(32), 1);
        await delivery.registerDevice(polar, "polar-service-b", new Uint8Array(32), 1);
        expect(state.deviceNotices).toEqual([ALICE, ALICE]);
    });

    it("an organization only shortens the device limit, and an account gets the strictest of its organizations", async () => {
        const delivery = await import("@/lib/chat/e2ee/mls-delivery");
        expect(delivery.strictestDays(30, [])).toBe(30);
        expect(delivery.strictestDays(30, [null, 14, 60])).toBe(14);
        expect(delivery.strictestDays(30, [90])).toBe(30);
        expect(delivery.strictestDays(30, [1])).toBe(7);

        await device(BOB, "bob-phone-1");
        await device(BOB, "bob-tablet");
        const tablet = state.tables.mlsDevice!.find((d) => d.device === "bob-tablet")!;
        tablet.lastSeenAt = new Date(Date.now() - 10 * 86_400_000);
        const devices = [`${BOB}/bob-phone-1`, `${BOB}/bob-tablet`];
        const retired = async () => (await call({ op: "roster", channelId: CHANNEL, accounts: [ALICE, BOB], devices, ciphersuite: 0x004f })).body.retired;
        await device(ALICE, "alice-laptop");
        expect(await retired()).toEqual([]);

        // Bob is on a roster with a 7-day limit: ten days unused is past it.
        state.tables.organization = [{ id: "org-a", ownerId: EVE, sealedDeviceDays: 7 }];
        state.tables.organizationMember = [{ orgId: "org-a", userId: BOB }];
        expect(await retired()).toEqual([`${BOB}/bob-tablet`]);
        // Owning one counts the same; a longer one never loosens the instance's 30.
        state.tables.organization = [{ id: "org-b", ownerId: BOB, sealedDeviceDays: 7 }, { id: "org-c", ownerId: EVE, sealedDeviceDays: 90 }];
        state.tables.organizationMember = [{ orgId: "org-c", userId: BOB }];
        expect(await retired()).toEqual([`${BOB}/bob-tablet`]);
        state.tables.organization = [{ id: "org-c", ownerId: EVE, sealedDeviceDays: 90 }, { id: "org-d", ownerId: EVE, sealedDeviceDays: null }];
        state.tables.organizationMember = [{ orgId: "org-c", userId: BOB }, { orgId: "org-d", userId: BOB }];
        expect(await retired()).toEqual([]);
        tablet.lastSeenAt = new Date(Date.now() - 31 * 86_400_000);
        expect(await retired()).toEqual([`${BOB}/bob-tablet`]);

        // The claim reads the same per-account cutoff: Alice's limit does not reach Bob.
        tablet.lastSeenAt = new Date(Date.now() - 10 * 86_400_000);
        state.tables.organization = [{ id: "org-a", ownerId: EVE, sealedDeviceDays: 7 }];
        state.tables.organizationMember = [{ orgId: "org-a", userId: ALICE }];
        await call({ op: "publish-key-packages", device: "bob-tablet", ciphersuite: 0x004f, keyPackages: [blob(5)] }, BOB);
        const claimed = await call({ op: "claim-key-packages", channelId: CHANNEL, userIds: [BOB], ciphersuite: 0x004f });
        expect((claimed.body.keyPackages as { address: string }[]).map((k) => k.address)).toEqual([`${BOB}/bob-tablet`]);
        state.tables.organizationMember = [{ orgId: "org-a", userId: BOB }];
        await call({ op: "publish-key-packages", device: "bob-tablet", ciphersuite: 0x004f, keyPackages: [blob(6)] }, BOB);
        expect((await call({ op: "claim-key-packages", channelId: CHANNEL, userIds: [BOB], ciphersuite: 0x004f })).body.keyPackages).toEqual([]);
    });

    it("notes a device's use at most once an hour, so an open tab never counts as inactive", async () => {
        await device(ALICE, "alice-laptop");
        const row = state.tables.mlsDevice!.find((d) => d.device === "alice-laptop")!;
        const longAgo = new Date(Date.now() - 40 * 86_400_000);
        row.lastSeenAt = longAgo;
        await call({ op: "events", channelId: CHANNEL, device: "alice-laptop", after: "0" });
        const seen = row.lastSeenAt as Date;
        expect(seen.getTime()).toBeGreaterThan(longAgo.getTime());
        await call({ op: "events", channelId: CHANNEL, device: "alice-laptop", after: "0" });
        expect(row.lastSeenAt).toBe(seen);
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

    it("names who is missing each key the server sealed and forgot, to a holder only, a page of epochs at a time", async () => {
        const { LEGACY_EPOCH, SWEEP_EPOCH_TOP } = await import("@/lib/chat/e2ee/mls-history-keys");
        const hold = (recipient: string, epoch: bigint) => (state.tables.chatHistoryKey ??= []).push({ channelId: CHANNEL, epoch, recipient, envelope: Buffer.alloc(8, 1) });
        (state.tables.chatAccountKey ??= []).push({ userId: BOB, akVersion: 1, signPublicKey: Buffer.alloc(32, 2), hpkePublicKey: Buffer.alloc(32, 3) });
        hold(ALICE, LEGACY_EPOCH);
        // Ten sweeps Alice holds; Bob came after all but the last, which he already holds; an MLS epoch is not the server's.
        for (let at = 0n; at < 10n; at++) hold(ALICE, SWEEP_EPOCH_TOP - at);
        hold(BOB, SWEEP_EPOCH_TOP - 9n);
        hold(ALICE, 3n);
        const first = await call({ op: "legacy-key-gaps", channelId: CHANNEL });
        expect(first.status).toBe(200);
        const named = (body: Record<string, unknown>) => (body.epochs as { epoch: string; accountKeys: { userId: string }[] }[]).map((entry) => [entry.epoch, entry.accountKeys.map((k) => k.userId)]);
        expect(named(first.body)).toEqual([[LEGACY_EPOCH.toString(), [BOB]], ...Array.from({ length: 7 }, (_, at) => [(SWEEP_EPOCH_TOP - BigInt(at)).toString(), [BOB]])]);
        // What an older browser reads: the migrated history's gaps alone.
        expect((first.body.accountKeys as { userId: string }[]).map((k) => k.userId)).toEqual([BOB]);
        expect(first.body.next).toBe((SWEEP_EPOCH_TOP - 7n).toString());
        const second = await call({ op: "legacy-key-gaps", channelId: CHANNEL, upTo: first.body.next });
        expect(named(second.body)).toEqual([[(SWEEP_EPOCH_TOP - 7n).toString(), [BOB]], [(SWEEP_EPOCH_TOP - 8n).toString(), [BOB]]]);
        expect(second.body.accountKeys).toEqual([]);
        expect(second.body.next).toBeNull();
        // Somebody in the conversation holding none of those keys learns nothing at all.
        state.members.add(`${EVE}:${CHANNEL}`);
        expect((await call({ op: "legacy-key-gaps", channelId: CHANNEL }, EVE)).body).toEqual({ accountKeys: [], epochs: [], next: null });
        expect((await call({ op: "legacy-key-gaps", channelId: CHANNEL, upTo: "x" })).status).toBe(400);
    });
});
