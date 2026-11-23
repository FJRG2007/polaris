/**
 * One device's side of chat MLS (docs/chat-e2ee-mls.md), against the delivery
 * service at `/api/e2ee/mls`: register the device and keep its key packages
 * topped up, create or join a conversation's group, add accounts to it, send
 * application messages and read the group's log in order.
 *
 * Crash safety is the store's (`@polaris/core-rs/mls-store`): every operation
 * commits the member's storage changes together with the request it has to
 * send, in one transaction, and only then sends it. A device restarted between
 * the two finds the request in the outbox and sends it again (`open`), so a
 * commit is never made locally and lost on the way to the server.
 *
 * The server only orders: a commit is taken for the epoch the group is at. A
 * device that loses that race drops its pending commit, reads the winner's and
 * tries again. A device too far behind to catch up commit by commit (the log
 * keeps 256 epochs) rejoins from the group's latest GroupInfo by an external
 * commit, after forgetting its own copy of the group. A device that lost its
 * store rejoins with a new key, so its old leaf is still in the group: it
 * removes that leaf itself once it is back (a device that kept its key needs
 * nothing, the external commit replaces its leaf). A device removed from the
 * group forgets it; a later Welcome, or a rejoin the server allows, brings it
 * back.
 *
 * History keys (docs/chat-e2ee-proposal.md 4.2 item 4): the device that moves
 * the group to a new epoch makes that epoch's history key `HK`, sends it to the
 * group as an MLS application message, and seals it to its own account and to
 * each account it just added (`sealHistoryKey`, the public keys from
 * `account-keys`). Every device that reads it seals it to its own account too
 * (the first envelope written wins), so the account's next new device - which
 * MLS cannot give the past - opens the history from those envelopes.
 * Application messages carry a one-byte kind in front: 0 content, 1 an `HK`.
 *
 * Nothing here is reachable while `chatE2eeEnabled()` is off: the route answers
 * 404 and no screen constructs a device.
 */

import type { MlsBody } from "./schemas";
import type { MlsHistoryKeyStore } from "./mls-history-keys";
import * as content from "@polaris/chat-crypto/message-content";

/** The hybrid ML-KEM-768 + X25519 suite (polaris_core::mls). */
export const MLS_SUITE = 0x004f;
/** The protocol version a device declares when it registers. */
export const MLS_E2EE_VERSION = 1;
const KEY_PACKAGE_TARGET = 20;
const KEY_PACKAGE_LOW = 10;
const COMMIT_ATTEMPTS = 3;
const EVENTS_PAGE = 200;
const CONTENT_KIND = 0;
const HISTORY_KEY_KIND = 1;

export interface MlsCommitOut {
    commit: Uint8Array;
    welcome?: Uint8Array | null;
    groupInfo?: Uint8Array | null;
}

export interface MlsProcessedOut {
    kind: string;
    senderIdentity: Uint8Array;
    plaintext: Uint8Array;
    epoch: bigint;
    active: boolean;
}

/** What this module uses of `MlsMember` (napi and WebAssembly expose the same). */
export interface MlsMemberLike {
    signaturePublicKey(): Uint8Array;
    keyPackage(): Uint8Array;
    createGroup(groupId: Uint8Array): void;
    addMembers(groupId: Uint8Array, keyPackages: Uint8Array[]): MlsCommitOut;
    removeMembers(groupId: Uint8Array, leaves: number[]): MlsCommitOut;
    forgetGroup(groupId: Uint8Array): void;
    members(groupId: Uint8Array): { leaf: number; identity: Uint8Array }[];
    ownLeaf(groupId: Uint8Array): number;
    signContent(payload: Uint8Array): Uint8Array;
    mergePendingCommit(groupId: Uint8Array): void;
    clearPendingCommit(groupId: Uint8Array): void;
    joinByWelcome(welcome: Uint8Array): Uint8Array;
    joinByExternalCommit(groupInfo: Uint8Array): { groupId: Uint8Array; commit: Uint8Array };
    groupInfo(groupId: Uint8Array): Uint8Array;
    encrypt(groupId: Uint8Array, plaintext: Uint8Array): Uint8Array;
    process(groupId: Uint8Array, message: Uint8Array): MlsProcessedOut;
    epoch(groupId: Uint8Array): bigint;
    storeChanges(): { key: Uint8Array; value?: Uint8Array | null }[];
}

export interface MlsMemberClass {
    new (identity: Uint8Array, ciphersuite: number, seed: Uint8Array): MlsMemberLike;
    restore(identity: Uint8Array, ciphersuite: number, seed: Uint8Array, keys: Uint8Array[], values: Uint8Array[], signaturePublicKey: Uint8Array): MlsMemberLike;
}

/** `IndexedDbMlsStore`'s surface. */
export interface MlsDeviceStore {
    load(): Promise<{ keys: Uint8Array[]; values: Uint8Array[]; outbox: { id: number; message: Uint8Array }[] }>;
    commit(changes: readonly { key: Uint8Array; value?: Uint8Array | null }[], messages?: readonly Uint8Array[]): Promise<number[]>;
    sent(id: number): Promise<void>;
}

/** Small public values kept beside the store: the signature key, each group's id and log cursor. */
export interface MlsDeviceNotes {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

/** A refusal from the delivery service: `reason` is its `error` field. */
export class MlsRequestError extends Error {
    constructor(
        readonly status: number,
        readonly reason: string
    ) {
        super(`the MLS delivery service refused the request (${status} ${reason})`);
        this.name = "MlsRequestError";
    }
}

export type MlsTransport = (body: MlsBody) => Promise<Record<string, unknown>>;

/** POST each op as JSON to the delivery route; a non-2xx answer throws `MlsRequestError`. */
export function fetchTransport(endpoint = "/api/e2ee/mls"): MlsTransport {
    return async (body) => {
        const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) throw new MlsRequestError(response.status, typeof answer.error === "string" ? answer.error : "unknown");
        return answer;
    };
}

/** A message another member sent to the group. */
export interface MlsApplication {
    channelId: string;
    /** `${userId}/${device}` of the sending device. */
    sender: string;
    epoch: bigint;
    plaintext: Uint8Array;
}

/** A stored sealed message, opened by `readSealed`. */
export interface MlsSealedMessage {
    id: string;
    authorId: string | null;
    /** `${userId}/${device}` of the device that signed it. */
    sender: string;
    epoch: bigint;
    /** The content; null when its signature or sealing does not check out, or no key here opens it. */
    opened: Uint8Array | null;
}

interface SealedWire {
    id: string;
    authorId: string | null;
    clientKey: string;
    device: string;
    epoch: string;
    senderLeaf: number;
    ciphertext: string;
    signature: string;
    signatureKey: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toText(value: Uint8Array): string {
    let binary = "";
    for (const byte of value) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromText(value: string): Uint8Array {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

interface LogEvent {
    seq: string;
    epoch: string;
    kind: string;
    sender: string;
    payload: string;
}

export interface MlsDeviceOptions {
    userId: string;
    device: string;
    MlsMember: MlsMemberClass;
    store: MlsDeviceStore;
    notes: MlsDeviceNotes;
    transport: MlsTransport;
    ciphersuite?: number;
    random?: (length: number) => Uint8Array;
    /**
     * The account key's HPKE pair, once the account key is unlocked: history
     * keys are sealed to the public half and opened with the private one.
     * Without it the device still reads and distributes history keys in the
     * group, and writes no envelope for its own account.
     */
    account?: { hpkePublicKey: Uint8Array; hpkePrivateKey: CryptoKey };
    /**
     * Where the history keys this device reads or makes are kept across
     * restarts, sealed (`IndexedDbHistoryKeyStore`). Without it they last one
     * run, and a device with its account key locked loses them on restart.
     */
    historyKeys?: MlsHistoryKeyStore;
}

export class MlsDevice {
    readonly address: string;
    private readonly ciphersuite: number;
    /** Messages read while catching up before a send, handed out by the next `sync`. */
    private readonly inbox: MlsApplication[] = [];
    /** Group ids and cursors belong to one member: a device whose store was lost starts with none. */
    private readonly scope: string;
    /** History keys this run holds, by `${channelId}/${epoch}` (the persisted ones load on first use). */
    private readonly historyKeys = new Map<string, Uint8Array>();

    private constructor(
        private readonly options: MlsDeviceOptions,
        private member: MlsMemberLike
    ) {
        this.address = `${options.userId}/${options.device}`;
        this.ciphersuite = options.ciphersuite ?? MLS_SUITE;
        this.scope = `${options.device}/${toText(member.signaturePublicKey()).slice(0, 16)}`;
    }

    /**
     * Restore this device from its store (a fresh member on first use), then
     * send whatever an earlier run committed and never got to send.
     */
    static async open(options: MlsDeviceOptions): Promise<MlsDevice> {
        const random = options.random ?? ((length) => crypto.getRandomValues(new Uint8Array(length)));
        const suite = options.ciphersuite ?? MLS_SUITE;
        const identity = encoder.encode(`${options.userId}/${options.device}`);
        const snapshot = await options.store.load();
        const signatureKey = options.notes.getItem(noteKey(options.device, "signature-key"));
        let member: MlsMemberLike;
        if (snapshot.keys.length && signatureKey)
            member = options.MlsMember.restore(identity, suite, random(32), snapshot.keys, snapshot.values, fromText(signatureKey));
        else {
            member = new options.MlsMember(identity, suite, random(32));
            await options.store.commit(member.storeChanges());
            options.notes.setItem(noteKey(options.device, "signature-key"), toText(member.signaturePublicKey()));
        }
        const device = new MlsDevice(options, member);
        for (const entry of snapshot.outbox) {
            await device.resend(JSON.parse(decoder.decode(entry.message)) as MlsBody);
            await options.store.sent(entry.id);
        }
        return device;
    }

    /** Register (or refresh) the device and top its one-use key packages up when they run low. */
    async register(): Promise<void> {
        const answer = await this.send({
            op: "register-device",
            device: this.options.device,
            signatureKey: toText(this.member.signaturePublicKey()),
            e2eeVersion: MLS_E2EE_VERSION,
            ciphersuite: this.ciphersuite as 0x004f
        });
        const held = typeof answer.heldKeyPackages === "number" ? answer.heldKeyPackages : 0;
        if (held >= KEY_PACKAGE_LOW) return;
        const keyPackages = Array.from({ length: KEY_PACKAGE_TARGET - held }, () => toText(this.member.keyPackage()));
        await this.commitAndSend({ op: "publish-key-packages", device: this.options.device, ciphersuite: this.ciphersuite as 0x004f, keyPackages, lastResort: false });
    }

    /**
     * The conversation's group id: the group this device is in, the one a
     * Welcome waiting in the log puts it in, a new one when nobody has created
     * it yet, or else the existing group joined by an external commit (a new
     * device of a member, or one that lost its store).
     */
    async ensureGroup(channelId: string): Promise<Uint8Array> {
        const known = this.groupOf(channelId);
        if (known) return known;
        const answer = await this.send({ op: "group", channelId });
        if (answer.group) {
            await this.sync(channelId);
            return this.groupOf(channelId) ?? (await this.rejoin(channelId));
        }
        const groupId = (this.options.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n))))(16);
        this.member.createGroup(groupId);
        const body: MlsBody = { op: "create-group", channelId, groupId: toText(groupId), ciphersuite: this.ciphersuite as 0x004f, groupInfo: toText(this.member.groupInfo(groupId)) };
        // Recorded before sending, so a restart that resends the create knows the group is this one.
        this.setGroup(channelId, groupId);
        try {
            await this.commitAndSend(body);
        } catch (caught) {
            if (!(caught instanceof MlsRequestError) || caught.reason !== "groupExists") throw caught;
            // Another device created it first: join that one.
            this.setGroup(channelId, null);
            return this.rejoin(channelId);
        }
        await this.distributeHistoryKey(channelId, []);
        return groupId;
    }

    /**
     * Add every device of these accounts to the conversation's group. Accounts
     * with no device registered are left out; the answer lists who was added.
     */
    async addAccounts(channelId: string, userIds: string[]): Promise<string[]> {
        const groupId = this.requireGroup(channelId);
        for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
            const claimed = await this.send({ op: "claim-key-packages", channelId, userIds, ciphersuite: this.ciphersuite as 0x004f });
            const packages = claimed.keyPackages as { address: string; keyPackage: string }[];
            if (!packages.length) return [];
            const epoch = this.member.epoch(groupId);
            const out = this.member.addMembers(groupId, packages.map((p) => fromText(p.keyPackage)));
            if (!out.welcome || !out.groupInfo) throw new Error("an MLS add commit came back without its Welcome or GroupInfo");
            const welcome = toText(out.welcome);
            const body: MlsBody = {
                op: "commit",
                channelId,
                device: this.options.device,
                epoch: epoch.toString(),
                commit: toText(out.commit),
                groupInfo: toText(out.groupInfo),
                welcomes: packages.map((p) => ({ recipient: p.address, welcome }))
            };
            if (await this.settleCommit(body, groupId)) {
                await this.distributeHistoryKey(channelId, [...new Set(packages.map((p) => p.address.slice(0, p.address.indexOf("/"))))]);
                return packages.map((p) => p.address);
            }
            // The epoch moved under us: catch up and claim fresh packages (the claimed ones are spent).
            await this.sync(channelId);
        }
        throw new MlsRequestError(409, "staleEpoch");
    }

    /**
     * Remove every device of these accounts from the conversation's group (an
     * account that left it). Returns the addresses removed; none when they
     * hold no leaf.
     */
    async removeAccounts(channelId: string, userIds: string[]): Promise<string[]> {
        const prefixes = userIds.map((id) => `${id}/`);
        return this.removeLeaves(channelId, (identity) => prefixes.some((prefix) => identity.startsWith(prefix)) && identity !== this.address);
    }

    /**
     * Commit the removal of the leaves whose identity `pick` selects, catching
     * up and choosing again when another commit wins the epoch.
     */
    private async removeLeaves(channelId: string, pick: (identity: string) => boolean): Promise<string[]> {
        for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
            const groupId = this.requireGroup(channelId);
            const own = this.member.ownLeaf(groupId);
            const leaves = this.member.members(groupId).flatMap((m) => {
                const identity = decoder.decode(m.identity);
                return m.leaf !== own && pick(identity) ? [{ leaf: m.leaf, identity }] : [];
            });
            if (!leaves.length) return [];
            const epoch = this.member.epoch(groupId);
            const out = this.member.removeMembers(groupId, leaves.map((l) => l.leaf));
            if (!out.groupInfo) throw new Error("an MLS remove commit came back without its GroupInfo");
            const body: MlsBody = {
                op: "commit",
                channelId,
                device: this.options.device,
                epoch: epoch.toString(),
                commit: toText(out.commit),
                groupInfo: toText(out.groupInfo),
                welcomes: []
            };
            if (await this.settleCommit(body, groupId)) {
                await this.distributeHistoryKey(channelId, []);
                return [...new Set(leaves.map((l) => l.identity))];
            }
            await this.sync(channelId);
        }
        throw new MlsRequestError(409, "staleEpoch");
    }

    /**
     * Encrypt and send one application message to the whole group, after
     * catching up: a message sealed in an epoch the group has left cannot be
     * read by the members that joined since.
     */
    async sendApplication(channelId: string, plaintext: Uint8Array): Promise<void> {
        this.requireGroup(channelId);
        await this.pull(channelId);
        const groupId = this.requireGroup(channelId);
        const epoch = this.member.epoch(groupId);
        const payload = this.member.encrypt(groupId, framed(CONTENT_KIND, plaintext));
        await this.commitAndSend({ op: "application", channelId, device: this.options.device, epoch: epoch.toString(), payload: toText(payload) });
    }

    /**
     * Seal a chat message's content under the group's current history key and
     * sign it with this device's key, then store it (`send-sealed`). The
     * message id is `clientKey`, made fresh for each message and reused only
     * to retry the same one. Returns the stored message's id.
     */
    async sendSealed(channelId: string, plaintext: Uint8Array, options: { clientKey?: string; parentId?: string | null } = {}): Promise<string> {
        this.requireGroup(channelId);
        await this.pull(channelId);
        const groupId = this.requireGroup(channelId);
        const epoch = this.member.epoch(groupId);
        const key = await this.historyKey(channelId, epoch);
        // Never sent in the clear instead: the caller shows the send as failed.
        if (!key) throw new Error("this device holds no history key for the conversation's current epoch");
        const clientKey = options.clientKey ?? crypto.randomUUID();
        const binding = { conversationId: channelId, epoch, messageId: clientKey, senderLeaf: this.member.ownLeaf(groupId) };
        const ciphertext = await content.sealMessage(key, binding, plaintext);
        const signature = this.member.signContent(await content.messageSignaturePayload(binding, ciphertext));
        const answer = await this.send({
            op: "send-sealed",
            channelId,
            device: this.options.device,
            clientKey,
            parentId: options.parentId ?? null,
            epoch: epoch.toString(),
            senderLeaf: binding.senderLeaf,
            ciphertext: toText(ciphertext),
            signature: toText(signature)
        });
        return String(answer.id);
    }

    /**
     * Read and open these sealed messages: each one's signature is checked
     * under the key the server held for its device, then its content opened
     * with the epoch's history key. A message that fails either comes back
     * without content (`opened: null`), never with what it claimed.
     */
    async readSealed(channelId: string, messageIds: string[]): Promise<MlsSealedMessage[]> {
        const answer = await this.send({ op: "read-sealed", channelId, messageIds });
        const rows = answer.messages as SealedWire[];
        const out: MlsSealedMessage[] = [];
        for (const row of rows) {
            const epoch = BigInt(row.epoch);
            const binding = { conversationId: channelId, epoch, messageId: row.clientKey, senderLeaf: row.senderLeaf };
            const ciphertext = fromText(row.ciphertext);
            let opened: Uint8Array | null = null;
            if (await content.verifyMessageSignature(fromText(row.signatureKey), binding, ciphertext, fromText(row.signature))) {
                const key = await this.historyKey(channelId, epoch).catch(() => null);
                if (key) opened = await content.openMessage(key, binding, ciphertext).catch(() => null);
            }
            out.push({ id: row.id, authorId: row.authorId, sender: `${row.authorId}/${row.device}`, epoch, opened });
        }
        return out;
    }

    /** Read the group's log from where this device left off; returns the application messages, in order. */
    async sync(channelId: string): Promise<MlsApplication[]> {
        await this.pull(channelId);
        const mine = this.inbox.filter((m) => m.channelId === channelId);
        this.inbox.splice(0, this.inbox.length, ...this.inbox.filter((m) => m.channelId !== channelId));
        return mine;
    }

    private async pull(channelId: string): Promise<void> {
        const cursorKey = this.note(`cursor/${channelId}`);
        for (;;) {
            const after = this.options.notes.getItem(cursorKey) ?? "0";
            const answer = await this.send({ op: "events", channelId, device: this.options.device, after });
            const events = answer.events as LogEvent[];
            for (const event of events) {
                const message = await this.apply(channelId, event);
                if (message) this.inbox.push(message);
                this.options.notes.setItem(cursorKey, event.seq);
            }
            if (events.length < EVENTS_PAGE) return;
        }
    }

    /** Leave the device's group state for this conversation behind and join it again from the latest GroupInfo. */
    async rejoin(channelId: string): Promise<Uint8Array> {
        for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
            const answer = await this.send({ op: "group", channelId });
            const group = answer.group as { groupId: string; epoch: string; groupInfo: string | null } | null;
            if (!group?.groupInfo) throw new MlsRequestError(404, "unknownGroup");
            // A copy of the group held from before (a fork, a device too far
            // behind, or the previous attempt's refused join) would refuse the join.
            this.forget(fromText(group.groupId));
            const joined = this.member.joinByExternalCommit(fromText(group.groupInfo));
            const body: MlsBody = {
                op: "commit",
                channelId,
                device: this.options.device,
                epoch: group.epoch,
                commit: toText(joined.commit),
                groupInfo: toText(this.member.groupInfo(joined.groupId)),
                welcomes: []
            };
            try {
                await this.commitAndSend(body);
            } catch (caught) {
                if (caught instanceof MlsRequestError && caught.reason === "staleEpoch") continue;
                throw caught;
            }
            this.setGroup(channelId, joined.groupId);
            // Everything up to this commit is behind the new state.
            await this.skipLogTo(channelId, BigInt(group.epoch));
            // A leaf of this address under another key is this device before it
            // lost its store. Clean-up, not the join: a failure leaves the
            // stale leaf (it reads nothing new) instead of failing the rejoin.
            await this.removeLeaves(channelId, (identity) => identity === this.address).catch((caught: unknown) => {
                console.warn("polaris: this device's old MLS leaf could not be removed:", caught);
            });
            // A removal above moved the epoch again and already gave it a key.
            if (this.member.epoch(joined.groupId) === BigInt(group.epoch) + 1n) await this.distributeHistoryKey(channelId, []);
            return joined.groupId;
        }
        throw new MlsRequestError(409, "staleEpoch");
    }

    /**
     * The conversation's history key for an epoch: the one this device read or
     * made (this run, or kept from an earlier one), else the envelope sealed to
     * this account. Null when none of them exists.
     */
    async historyKey(channelId: string, epoch: bigint): Promise<Uint8Array | null> {
        const held = this.historyKeys.get(`${channelId}/${epoch}`);
        if (held) return held;
        const kept = await this.options.historyKeys?.get(channelId, epoch).catch((caught: unknown) => {
            console.warn("polaris: the device's kept history keys could not be read:", caught);
            return null;
        });
        if (kept) {
            this.historyKeys.set(`${channelId}/${epoch}`, kept);
            return kept;
        }
        const account = this.options.account;
        if (!account) return null;
        const answer = await this.send({ op: "history-keys", channelId, from: epoch.toString() });
        const found = (answer.historyKeys as { epoch: string; envelope: string }[]).find((k) => k.epoch === epoch.toString());
        if (!found) return null;
        const binding = { recipient: this.options.userId, conversationId: channelId, epoch };
        const key = await content.openHistoryKey(account.hpkePrivateKey, fromText(found.envelope), binding);
        await this.keepHistoryKey(channelId, epoch, key);
        return key;
    }

    /** Hold a history key for this run and keep it for the next. */
    private async keepHistoryKey(channelId: string, epoch: bigint, key: Uint8Array): Promise<void> {
        this.historyKeys.set(`${channelId}/${epoch}`, key);
        await this.options.historyKeys?.put(channelId, epoch, key).catch((caught: unknown) => {
            // The account envelopes still hold it for a device whose account key is unlocked.
            console.warn("polaris: a history key could not be kept on this device:", caught);
        });
    }

    /**
     * Give the epoch this device just committed its history key: to the group
     * as an application message, and sealed to this account and `accounts`.
     * Best effort - the commit stands either way, and a member that misses the
     * message still opens the key from its account's envelope.
     */
    private async distributeHistoryKey(channelId: string, accounts: string[]): Promise<void> {
        try {
            const groupId = this.requireGroup(channelId);
            const epoch = this.member.epoch(groupId);
            const key = content.newHistoryKey();
            // Kept before it is sent: a restart after the send still holds it.
            await this.keepHistoryKey(channelId, epoch, key);
            const payload = this.member.encrypt(groupId, framed(HISTORY_KEY_KIND, key));
            await this.commitAndSend({ op: "application", channelId, device: this.options.device, epoch: epoch.toString(), payload: toText(payload) });
            await this.sealHistoryKey(channelId, epoch, key, accounts);
        } catch (caught) {
            console.warn("polaris: a history key could not be distributed:", caught);
        }
    }

    /** Seal `key` to this account and to `others` that have an account key, and store the envelopes. */
    private async sealHistoryKey(channelId: string, epoch: bigint, key: Uint8Array, others: string[]): Promise<void> {
        const envelopes: { recipient: string; envelope: string }[] = [];
        const seal = async (recipient: string, publicKey: Uint8Array) =>
            envelopes.push({ recipient, envelope: toText(await content.sealHistoryKey(publicKey, key, { recipient, conversationId: channelId, epoch })) });
        if (this.options.account) await seal(this.options.userId, this.options.account.hpkePublicKey);
        const recipients = others.filter((id) => id !== this.options.userId);
        if (recipients.length) {
            const answer = await this.send({ op: "account-keys", channelId, userIds: recipients });
            for (const found of answer.accountKeys as { userId: string; hpkePublicKey: string }[]) await seal(found.userId, fromText(found.hpkePublicKey));
        }
        if (envelopes.length) await this.send({ op: "put-history-keys", channelId, epoch: epoch.toString(), envelopes });
    }

    /** Drop the member's copy of a group, if it holds one. */
    private forget(groupId: Uint8Array): void {
        try {
            this.member.forgetGroup(groupId);
        } catch {
            // Not held: nothing to forget.
        }
    }

    groupOf(channelId: string): Uint8Array | null {
        const known = this.options.notes.getItem(this.note(`group/${channelId}`));
        return known ? fromText(known) : null;
    }

    private note(name: string): string {
        return noteKey(this.scope, name);
    }

    private setGroup(channelId: string, groupId: Uint8Array | null): void {
        this.options.notes.setItem(this.note(`group/${channelId}`), groupId ? toText(groupId) : "");
    }

    private requireGroup(channelId: string): Uint8Array {
        const groupId = this.groupOf(channelId);
        if (!groupId) throw new Error("this device is not in the conversation's MLS group yet");
        return groupId;
    }

    private async apply(channelId: string, event: LogEvent): Promise<MlsApplication | null> {
        const payload = fromText(event.payload);
        const epoch = BigInt(event.epoch);
        let groupId = this.groupOf(channelId);
        if (event.kind === "welcome") {
            if (groupId) return null;
            try {
                groupId = this.member.joinByWelcome(payload);
            } catch (caught) {
                // A Welcome to this address under a key the device no longer holds (it lost its store).
                console.warn("polaris: an MLS Welcome could not be opened and was skipped:", caught);
                return null;
            }
            await this.options.store.commit(this.member.storeChanges());
            this.setGroup(channelId, groupId);
            return null;
        }
        // Before its Welcome a device cannot read the group; after a commit it already applied (its own) there is nothing to do.
        if (!groupId) return null;
        const local = this.member.epoch(groupId);
        if (epoch < local) return null;
        if (epoch > local) {
            await this.rejoin(channelId);
            return null;
        }
        // Its own messages come back in the log too; a member cannot (and need
        // not) read those. Its own commits never get here (merged, so their
        // epoch is behind): a commit from this address at this epoch is from
        // an earlier copy of this device, such as its removal by the copy that
        // replaced it, and is applied.
        if (event.sender === this.address && event.kind !== "commit") return null;
        let processed: MlsProcessedOut;
        try {
            processed = this.member.process(groupId, payload);
        } catch (caught) {
            // A commit at our own epoch that does not apply leaves us on a fork of one; anything else is skipped.
            if (event.kind === "commit") {
                await this.rejoin(channelId);
                return null;
            }
            console.warn("polaris: an MLS message could not be read and was skipped:", caught);
            return null;
        }
        await this.options.store.commit(this.member.storeChanges());
        // Removed: the member already dropped the group's state; so does the device.
        if (!processed.active) {
            this.setGroup(channelId, null);
            return null;
        }
        if (processed.kind !== "application") return null;
        const [kind, body] = [processed.plaintext[0], processed.plaintext.subarray(1)];
        if (kind === HISTORY_KEY_KIND) {
            if (body.length !== content.HISTORY_KEY_BYTES) return null;
            await this.keepHistoryKey(channelId, processed.epoch, new Uint8Array(body));
            await this.sealHistoryKey(channelId, processed.epoch, body, []).catch((caught: unknown) => {
                console.warn("polaris: a history key could not be sealed to this account:", caught);
            });
            return null;
        }
        if (kind !== CONTENT_KIND) return null;
        return { channelId, sender: decoder.decode(processed.senderIdentity), epoch: processed.epoch, plaintext: new Uint8Array(body) };
    }

    /** Move the log cursor past every event before `epoch` (after a rejoin). */
    private async skipLogTo(channelId: string, epoch: bigint): Promise<void> {
        const cursorKey = this.note(`cursor/${channelId}`);
        for (;;) {
            const after = this.options.notes.getItem(cursorKey) ?? "0";
            const events = (await this.send({ op: "events", channelId, device: this.options.device, after })).events as LogEvent[];
            for (const event of events) {
                if (BigInt(event.epoch) > epoch) return;
                this.options.notes.setItem(cursorKey, event.seq);
            }
            if (events.length < EVENTS_PAGE) return;
        }
    }

    /** Persist the member's changes with the request, then send it and mark it sent. */
    private async commitAndSend(body: MlsBody): Promise<Record<string, unknown>> {
        const [id] = await this.options.store.commit(this.member.storeChanges(), [encoder.encode(JSON.stringify(body))]);
        const answer = await this.send(body).catch(async (caught: unknown) => {
            // A refusal is final for this request; a network failure leaves it in the outbox for the next start.
            if (caught instanceof MlsRequestError && id !== undefined) await this.options.store.sent(id);
            throw caught;
        });
        if (id !== undefined) await this.options.store.sent(id);
        return answer;
    }

    /**
     * Send a commit made in `body.epoch` and settle the pending commit: merged
     * when the server took it, dropped when another commit won the epoch.
     */
    private async settleCommit(body: Extract<MlsBody, { op: "commit" }>, groupId: Uint8Array): Promise<boolean> {
        try {
            await this.commitAndSend(body);
        } catch (caught) {
            if (!(caught instanceof MlsRequestError) || caught.reason !== "staleEpoch") throw caught;
            this.member.clearPendingCommit(groupId);
            await this.options.store.commit(this.member.storeChanges());
            return false;
        }
        this.member.mergePendingCommit(groupId);
        await this.options.store.commit(this.member.storeChanges());
        return true;
    }

    /**
     * Send again what an earlier run committed. A commit the server already
     * took (the run died before it heard) comes back `staleEpoch`; the log then
     * says whether the commit at that epoch is ours, and it is merged if so.
     */
    private async resend(body: MlsBody): Promise<void> {
        if (body.op !== "commit") {
            await this.send(body).catch((caught: unknown) => {
                if (!(caught instanceof MlsRequestError)) throw caught;
                // Another device's group won: `ensureGroup` joins that one.
                if (body.op === "create-group") this.setGroup(body.channelId, null);
            });
            return;
        }
        const groupId = this.groupOf(body.channelId);
        // An external join records the group only once the server takes it.
        if (!groupId) return void (await this.send(body).catch(() => undefined));
        try {
            await this.send(body);
        } catch (caught) {
            if (!(caught instanceof MlsRequestError) || caught.reason !== "staleEpoch") throw caught;
            if (!(await this.logHasCommit(body))) {
                this.member.clearPendingCommit(groupId);
                await this.options.store.commit(this.member.storeChanges());
                return;
            }
        }
        this.member.mergePendingCommit(groupId);
        await this.options.store.commit(this.member.storeChanges());
    }

    private async logHasCommit(body: Extract<MlsBody, { op: "commit" }>): Promise<boolean> {
        const want = fromText(body.commit);
        let after = "0";
        for (;;) {
            const events = (await this.send({ op: "events", channelId: body.channelId, device: this.options.device, after })).events as LogEvent[];
            for (const event of events) {
                if (event.kind === "commit" && event.epoch === body.epoch) return event.sender === this.address && sameBytes(fromText(event.payload), want);
                after = event.seq;
            }
            if (events.length < EVENTS_PAGE) return false;
        }
    }

    private send(body: MlsBody): Promise<Record<string, unknown>> {
        return this.options.transport(body);
    }
}

function framed(kind: number, body: Uint8Array): Uint8Array {
    const out = new Uint8Array(body.length + 1);
    out[0] = kind;
    out.set(body, 1);
    return out;
}

function noteKey(device: string, name: string): string {
    return `polaris-mls/${device}/${name}`;
}
