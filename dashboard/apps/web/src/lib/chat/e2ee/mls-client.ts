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
 * MLS cannot give the past - opens the history from those envelopes. The
 * committer also seals it to every other member with an account key
 * (`member-account-keys`), so a member with no device in the group yet - a
 * dormant one - finds it too.
 * Before sealing a message a device brings the group's leaves in line with the
 * conversation (`reconcile`): the devices of anybody who left are taken out,
 * and those of anybody in it with no leaf are added, so a message is never
 * sealed to a key of somebody who left, whoever moved who and from where.
 * Application messages carry a one-byte kind in front: 0 content, 1 an `HK`.
 *
 * Nothing here is reachable while `chatE2eeEnabled()` is off: the route answers
 * 404 and no screen constructs a device.
 */

import type { MlsBody } from "./schemas";
import { LEGACY_EPOCH, type MlsHistoryKeyStore } from "./mls-history-keys";
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
/** Envelopes per `put-history-keys` request. */
const ENVELOPES_PER_PUT = 100;
/** Member pages a committer reads (100 members each): a conversation's first 10,000 people. */
const MEMBER_PAGES = 100;
/** How often one run asks whether a conversation's migrated history still has members to be sealed to. */
const LEGACY_SHARE_MS = 10 * 60 * 1000;
/** Accounts per `roster` request. */
const ROSTER_PAGE = 1_000;
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `${userId}/${device}`, as the delivery service addresses a device. */
const DEVICE_ADDRESS = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9_-]{8,64}$/;

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
        readonly reason: string,
        /** The refusal in the reader's language, when the server answered one (a chat rule). */
        readonly text?: string
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
        if (!response.ok) throw requestError(response.status, answer);
        return answer;
    };
}

/** A refused answer as the error a caller reads its reason and its reader's sentence from. */
export function requestError(status: number, answer: Record<string, unknown>): MlsRequestError {
    return new MlsRequestError(status, typeof answer.error === "string" ? answer.error : "unknown", typeof answer.text === "string" ? answer.text : undefined);
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
    /** `${userId}/${device}` of the device that signed it; null when the server names no account for it. */
    sender: string | null;
    epoch: bigint;
    /** Which version of the message this is: 0 as sent, one more per edit. */
    revision: number;
    /**
     * The content; null when its signature or sealing does not check out, no
     * key here opens it, or it is older than a version this device has seen.
     */
    opened: Uint8Array | null;
}

/** A sealed message's stored columns, as the server hands them back (bytes in base64url). */
export interface SealedStored {
    /** The message id the content is bound to. */
    clientKey: string;
    device: string;
    epoch: string;
    senderLeaf: number;
    /** Which version of the message: 0 as sent, one more per edit; absent (0) from older servers. */
    revision?: number;
    ciphertext: string;
    signature: string;
    signatureKey: string;
}

interface SealedWire extends SealedStored {
    id: string;
    authorId: string | null;
    /** The account of the signing device when `authorId` is null (a member the server runs); absent from older servers. */
    signer?: string | null;
}

/** How many times an edit is sealed again when another device's edit landed first. */
const EDIT_ATTEMPTS = 3;

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

/** The account ids in an answer's list; anything else in it is ignored. */
function accountIds(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && ACCOUNT_ID.test(id)) : [];
}

function deviceAddresses(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((address): address is string => typeof address === "string" && DEVICE_ADDRESS.test(address)) : [];
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
    /** When this run last passed each conversation's migrated history on, by channel. */
    private readonly legacyShared = new Map<string, number>();

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
            // Noted first: a store that carries notes in its commit (the server's) writes both at once.
            options.notes.setItem(noteKey(options.device, "signature-key"), toText(member.signaturePublicKey()));
            await options.store.commit(member.storeChanges());
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

    /** Whether this device is in the conversation's group (as far as it has read). */
    hasGroup(channelId: string): boolean {
        return this.groupOf(channelId) !== null;
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
            // `pull`, not `sync`: messages read after the Welcome wait for the caller's next `sync`.
            await this.pull(channelId);
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
        let wanted = userIds;
        for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
            // After losing the epoch, the accounts the winning commit already added are not added twice.
            if (attempt) {
                const present = new Set(this.rosterAccounts(groupId));
                wanted = wanted.filter((id) => !present.has(id));
                if (!wanted.length) return [];
            }
            const claimed = await this.send({ op: "claim-key-packages", channelId, userIds: wanted, ciphersuite: this.ciphersuite as 0x004f });
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
     * Bring the group's leaves in line with who is in the conversation, as
     * the server answers it (`roster`): every device of the accounts that
     * left is removed, then the devices of the people in it who hold no leaf
     * are added (a Welcome, and the new epoch's history key sealed to them),
     * so they read what is said next without having opened the conversation.
     * In the same commit go the leaves of retired devices - a browser its
     * account signed out of, or one unseen past the instance's limit (decision
     * 7) - of anybody, this account's other devices included: a lost browser
     * stops receiving what is said from the next send on. A retired device that
     * comes back rejoins by its own external commit.
     * A removal that fails fails the caller - `sendSealed` does not seal past
     * it; an add that fails is logged and tried again next time, and the
     * newcomer can still join by its own external commit.
     */
    async reconcile(channelId: string): Promise<void> {
        await this.shareLegacyKey(channelId);
        const roster = this.rosterAccounts(this.requireGroup(channelId));
        if (!roster.length) return;
        const leaves = this.leafAddresses(this.requireGroup(channelId)).filter((address) => address !== this.address);
        const departed = new Set<string>();
        const joinable = new Set<string>();
        const retired = new Set<string>();
        for (let start = 0; start < roster.length; start += ROSTER_PAGE) {
            const accounts = roster.slice(start, start + ROSTER_PAGE);
            const page = new Set(accounts);
            const devices = leaves.filter((address) => page.has(address.slice(0, address.indexOf("/")))).slice(0, ROSTER_PAGE);
            const answer = await this.send({ op: "roster", channelId, accounts, devices, ciphersuite: this.ciphersuite as 0x004f });
            for (const id of accountIds(answer.departed)) departed.add(id);
            for (const id of accountIds(answer.joinable)) joinable.add(id);
            for (const address of deviceAddresses(answer.retired)) if (page.has(address.slice(0, address.indexOf("/")))) retired.add(address);
        }
        departed.delete(this.options.userId);
        retired.delete(this.address);
        if (departed.size || retired.size) {
            const prefixes = [...departed].map((id) => `${id}/`);
            await this.removeLeaves(channelId, (identity) => identity !== this.address && (retired.has(identity) || prefixes.some((prefix) => identity.startsWith(prefix))));
        }
        const present = new Set(this.rosterAccounts(this.requireGroup(channelId)));
        const adding = [...joinable].filter((id) => !present.has(id) && !departed.has(id));
        if (!adding.length) return;
        await this.addAccounts(channelId, adding).catch((caught: unknown) => {
            console.warn("polaris: people new to a sealed conversation could not be added to its group:", caught);
        });
    }

    /** The device addresses holding a leaf in this copy of the group, this device's own among them. */
    private leafAddresses(groupId: Uint8Array): string[] {
        return [...new Set(this.member.members(groupId).map((m) => decoder.decode(m.identity)))].filter((address) => DEVICE_ADDRESS.test(address));
    }

    /**
     * This device is leaving for good (its account signs out of the browser):
     * the server forgets it and its key packages, and every group drops its
     * leaf at the next member's send.
     */
    async retire(): Promise<void> {
        await this.send({ op: "retire-device", device: this.options.device });
    }

    /** The accounts holding a leaf in this copy of the group, this device's own among them. */
    private rosterAccounts(groupId: Uint8Array): string[] {
        const accounts = this.member.members(groupId).map((m) => {
            const identity = decoder.decode(m.identity);
            return identity.slice(0, identity.indexOf("/"));
        });
        return [...new Set(accounts)].filter((id) => ACCOUNT_ID.test(id));
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
    async sendSealed(
        channelId: string,
        plaintext: Uint8Array,
        options: {
            clientKey?: string;
            parentId?: string | null;
            replyToId?: string | null;
            uploads?: readonly string[];
            /** A sealed poll: how many answers it has (their words are in the seal) and its rules. */
            poll?: { options: number; multiple: boolean; hideResults: boolean; anonymous: boolean; hours: number };
        } = {}
    ): Promise<string> {
        this.requireGroup(channelId);
        await this.pull(channelId);
        await this.reconcile(channelId);
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
            replyToId: options.replyToId ?? null,
            ...(options.uploads?.length ? { uploads: [...options.uploads] } : {}),
            ...(options.poll ? { poll: options.poll } : {}),
            epoch: epoch.toString(),
            senderLeaf: binding.senderLeaf,
            ciphertext: toText(ciphertext),
            signature: toText(signature)
        });
        return String(answer.id);
    }

    /**
     * Seal a poll ballot (`content.encodeBallot` picks) under the group's
     * current history key, the group brought up to date first as for a send,
     * so somebody who left cannot open it. `voter` is this account on a public
     * poll and null on an anonymous one. Answers what the server stores.
     */
    async sealBallot(channelId: string, pollId: string, voter: string | null, picks: readonly number[]): Promise<{ ballotId: string; epoch: string; sealed: string }> {
        this.requireGroup(channelId);
        await this.pull(channelId);
        await this.reconcile(channelId);
        const epoch = this.member.epoch(this.requireGroup(channelId));
        const key = await this.historyKey(channelId, epoch);
        // Never voted in the clear instead: the caller shows the vote as not counted.
        if (!key) throw new Error("this device holds no history key for the conversation's current epoch");
        const ballotId = crypto.randomUUID();
        const binding = { conversationId: channelId, epoch, pollId, ballotId, voter };
        const sealed = await content.sealBallot(key, binding, content.encodeBallot(picks));
        return { ballotId, epoch: epoch.toString(), sealed: toText(sealed) };
    }

    /** The picks of a stored ballot, or null for one that does not open here. */
    async openBallot(channelId: string, pollId: string, voter: string | null, row: { ballotId: string; epoch: string; sealed: string }): Promise<number[] | null> {
        const epoch = BigInt(row.epoch);
        const key = await this.historyKey(channelId, epoch).catch(() => null);
        if (!key) return null;
        const binding = { conversationId: channelId, epoch, pollId, ballotId: row.ballotId, voter };
        const opened = await content.openBallot(key, binding, fromText(row.sealed)).catch(() => null);
        return opened ? content.decodeBallot(opened) : null;
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
            // A member the server runs stores no author; the account its device signs as comes beside it.
            const signer = row.authorId ?? row.signer ?? null;
            const revision = row.revision ?? 0;
            // A version below one this device has seen is the server handing back an earlier one: not shown as the message.
            const current = revision >= this.revisionFloor(channelId, row.id);
            const opened = current ? await this.openStored(channelId, row) : null;
            if (opened) this.raiseRevisionFloor(channelId, row.id, revision);
            out.push({ id: row.id, authorId: row.authorId, sender: signer ? `${signer}/${row.device}` : null, epoch: BigInt(row.epoch), revision, opened });
        }
        return out;
    }

    /**
     * Open the earlier versions of a sealed message its edit history holds,
     * checked as `readSealed` checks the message; null for one that does not
     * check out or that no key here opens.
     */
    async openVersions(channelId: string, messageId: string, versions: readonly SealedStored[]): Promise<(Uint8Array | null)[]> {
        const out: (Uint8Array | null)[] = [];
        for (const version of versions) {
            const opened = await this.openStored(channelId, version);
            // A replaced version its device signed means the message is past it.
            if (opened) this.raiseRevisionFloor(channelId, messageId, (version.revision ?? 0) + 1);
            out.push(opened);
        }
        return out;
    }

    /** The lowest revision this device still takes as the message's current one (0 when it has seen none). */
    private revisionFloor(channelId: string, messageId: string): number {
        const kept = Number(this.options.notes.getItem(this.note(`revision/${channelId}/${messageId}`)) ?? 0);
        return Number.isSafeInteger(kept) && kept > 0 ? kept : 0;
    }

    /**
     * Remember that this message is at `revision` or later, so the server can
     * never hand this device an earlier version as the latest. Only edited
     * messages leave a note (revision 0 is every message's floor anyway).
     */
    private raiseRevisionFloor(channelId: string, messageId: string, revision: number): void {
        if (revision <= this.revisionFloor(channelId, messageId)) return;
        try {
            this.options.notes.setItem(this.note(`revision/${channelId}/${messageId}`), String(revision));
        } catch (caught) {
            // A full store only loses the floor for this message; the message still opens.
            console.warn("polaris: a sealed message's revision could not be kept:", caught);
        }
    }

    private async openStored(channelId: string, row: SealedStored): Promise<Uint8Array | null> {
        const epoch = BigInt(row.epoch);
        const revision = row.revision ?? 0;
        if (!Number.isSafeInteger(revision) || revision < 0 || revision > content.MAX_REVISION) return null;
        const binding = { conversationId: channelId, epoch, messageId: row.clientKey, senderLeaf: row.senderLeaf, revision };
        const ciphertext = fromText(row.ciphertext);
        if (!(await content.verifyMessageSignature(fromText(row.signatureKey), binding, ciphertext, fromText(row.signature)))) return null;
        const key = await this.historyKey(channelId, epoch).catch(() => null);
        return key ? await content.openMessage(key, binding, ciphertext).catch(() => null) : null;
    }

    /**
     * Seal a new version of one of this account's sealed messages under the
     * group's current history key, bound to the same message id (`clientKey`,
     * the one it was sent with) and signed by this device, and store it in
     * place of the old one (`edit-sealed`). The group is brought up to date
     * first, as for a send, so nobody who left can open the new words. The new
     * version is the next revision of the one stored; when another device's
     * edit lands first, it is sealed again over that one.
     * Answers when the server stored it (the row's new edit time).
     */
    async editSealed(channelId: string, messageId: string, plaintext: Uint8Array): Promise<string> {
        this.requireGroup(channelId);
        for (let attempt = 1; ; attempt++) {
            try {
                return await this.editSealedOnce(channelId, messageId, plaintext);
            } catch (caught) {
                if (attempt >= EDIT_ATTEMPTS || !(caught instanceof MlsRequestError) || caught.reason !== "staleRevision") throw caught;
            }
        }
    }

    private async editSealedOnce(channelId: string, messageId: string, plaintext: Uint8Array): Promise<string> {
        const read = await this.send({ op: "read-sealed", channelId, messageIds: [messageId] });
        const stored = (read.messages as SealedWire[]).find((row) => row.id === messageId);
        if (!stored?.clientKey) throw new MlsRequestError(404, "notSealed");
        const { clientKey } = stored;
        const current = stored.revision ?? 0;
        // Never an edit over a version older than one this device has seen: the server would be hiding the latest.
        if (current < this.revisionFloor(channelId, messageId) || current >= content.MAX_REVISION) throw new MlsRequestError(409, "staleRevision");
        const revision = current + 1;
        await this.pull(channelId);
        await this.reconcile(channelId);
        const groupId = this.requireGroup(channelId);
        const epoch = this.member.epoch(groupId);
        const key = await this.historyKey(channelId, epoch);
        // Never sent in the clear instead: the caller puts the old text back.
        if (!key) throw new Error("this device holds no history key for the conversation's current epoch");
        const binding = { conversationId: channelId, epoch, messageId: clientKey, senderLeaf: this.member.ownLeaf(groupId), revision };
        const ciphertext = await content.sealMessage(key, binding, plaintext);
        const signature = this.member.signContent(await content.messageSignaturePayload(binding, ciphertext));
        const answer = await this.send({
            op: "edit-sealed",
            channelId,
            device: this.options.device,
            messageId,
            epoch: epoch.toString(),
            senderLeaf: binding.senderLeaf,
            revision,
            ciphertext: toText(ciphertext),
            signature: toText(signature)
        });
        this.raiseRevisionFloor(channelId, messageId, revision);
        return String(answer.editedAt);
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
            await this.sealHistoryKey(channelId, epoch, key, accounts, true);
        } catch (caught) {
            console.warn("polaris: a history key could not be distributed:", caught);
        }
    }

    /**
     * Seal `key` to this account and to `others` that have an account key, and
     * store the envelopes. `everyMember` (the committer) also seals it to every
     * member of the conversation with an account key - the dormant ones too,
     * with no device in the group, so their first device reads this epoch.
     */
    private async sealHistoryKey(channelId: string, epoch: bigint, key: Uint8Array, others: string[], everyMember = false): Promise<void> {
        const envelopes: { recipient: string; envelope: string }[] = [];
        const sealed = new Set<string>();
        const seal = async (recipient: string, publicKey: Uint8Array) => {
            if (sealed.has(recipient)) return;
            sealed.add(recipient);
            envelopes.push({ recipient, envelope: toText(await content.sealHistoryKey(publicKey, key, { recipient, conversationId: channelId, epoch })) });
        };
        if (this.options.account) await seal(this.options.userId, this.options.account.hpkePublicKey);
        // Never sealed to this account under a key the server handed out: its own is `account`.
        sealed.add(this.options.userId);
        const recipients = others.filter((id) => !sealed.has(id));
        if (recipients.length) {
            const answer = await this.send({ op: "account-keys", channelId, userIds: recipients });
            for (const found of answer.accountKeys as { userId: string; hpkePublicKey: string }[]) await seal(found.userId, fromText(found.hpkePublicKey));
        }
        for (let after: string | undefined, pages = 0; everyMember && pages < MEMBER_PAGES; pages++) {
            const answer = await this.send({ op: "member-account-keys", channelId, ...(after ? { after } : {}) });
            for (const found of answer.accountKeys as { userId: string; hpkePublicKey: string }[]) await seal(found.userId, fromText(found.hpkePublicKey));
            if (typeof answer.next !== "string") break;
            after = answer.next;
        }
        for (let at = 0; at < envelopes.length; at += ENVELOPES_PER_PUT)
            await this.send({ op: "put-history-keys", channelId, epoch: epoch.toString(), envelopes: envelopes.slice(at, at + ENVELOPES_PER_PUT) });
    }

    /**
     * Pass the conversation's migrated history on (`legacy-migration.ts`): the
     * server sealed its key to the members who had an account key at the time
     * and then forgot it, so a member whose account key came later has nothing
     * to open that history with until a member who holds it seals it to them.
     * The server lists who is still missing it, and only to a holder. Best
     * effort and at most every `LEGACY_SHARE_MS` per conversation: the next
     * send tries again.
     */
    async shareLegacyKey(channelId: string, now = Date.now()): Promise<number> {
        const last = this.legacyShared.get(channelId);
        if (last !== undefined && now - last < LEGACY_SHARE_MS) return 0;
        this.legacyShared.set(channelId, now);
        try {
            const answer = await this.send({ op: "legacy-key-gaps", channelId });
            const gaps = (answer.accountKeys ?? []) as { userId: string; hpkePublicKey: string }[];
            const others = gaps.filter((gap) => gap.userId !== this.options.userId);
            if (!others.length) return 0;
            const key = await this.historyKey(channelId, LEGACY_EPOCH);
            if (!key) return 0;
            const envelopes: { recipient: string; envelope: string }[] = [];
            for (const gap of others) {
                const binding = { recipient: gap.userId, conversationId: channelId, epoch: LEGACY_EPOCH };
                envelopes.push({ recipient: gap.userId, envelope: toText(await content.sealHistoryKey(fromText(gap.hpkePublicKey), key, binding)) });
            }
            for (let at = 0; at < envelopes.length; at += ENVELOPES_PER_PUT)
                await this.send({ op: "put-history-keys", channelId, epoch: LEGACY_EPOCH.toString(), envelopes: envelopes.slice(at, at + ENVELOPES_PER_PUT) });
            return envelopes.length;
        } catch (caught) {
            console.warn("polaris: a conversation's migrated history could not be passed on:", caught);
            return 0;
        }
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

/** The note `MlsDevice.open` needs to restore a device's member: without it the device starts over. */
export function signatureNoteKey(device: string): string {
    return noteKey(device, "signature-key");
}

function noteKey(device: string, name: string): string {
    return `polaris-mls/${device}/${name}`;
}
