/**
 * The MLS delivery service for chat (docs/chat-e2ee-mls.md; RFC 9750's DS
 * role): it stores and routes bytes it cannot read. Devices, their one-use key
 * packages, one group per conversation, an ordered log per group and the
 * history-key envelopes. Everything cryptographic happens on the devices (and,
 * for the members the server runs, in `mls-store.ts`).
 *
 * Ordering is the one thing the server decides: a commit is accepted only for
 * the epoch the group is at, as one compare-and-set, so two devices committing
 * at once never fork the group - the loser is told the epoch moved, processes
 * the winner's commit and tries again. Recovery for a device that lost its
 * state is the latest GroupInfo, kept here for an external commit.
 *
 * Callers authorize first (the route checks the session and that the account
 * reaches the conversation); this module only enforces bounds.
 */

import { prisma } from "@polaris/db";
import { getSetting } from "@/lib/setting-store";
import { SERVICE_ACCOUNT_IDS } from "@/lib/chat/service-ids";
import { SWEEP_EPOCH_FLOOR } from "./mls-history-keys";

export const MAX_KEY_PACKAGES_PER_DEVICE = 100;
export const MAX_CLAIM_USERS = 100;
export const MAX_EVENTS_PER_READ = 200;
export const MAX_WELCOMES_PER_COMMIT = 100;
/**
 * How many epochs a large group's tree is kept for (`MlsTreePart`): a Welcome
 * needs the tree of the epoch it was made in, so one that waits while the
 * group moves this many epochs on is past it and its device joins by external
 * commit from the latest tree instead. At ~2.6 MB of tree per thousand
 * members, this bounds what one group holds.
 */
export const TREE_EPOCHS = 4n;
/** Key-package rows `accountsWithKeyPackages` reads at most. */
const MAX_KEY_PACKAGE_ROWS = 2_000;
/**
 * How much of a group's log is kept: the last 256 epochs. A device further
 * behind than that cannot catch up commit by commit anyway once one is gone,
 * and rejoins from the latest GroupInfo by an external commit, which is what
 * the group keeps it for. Pruned every 32 epochs, inside the commit's own
 * transaction, so the log of a busy group stays bounded with no job to run.
 */
export const RETAINED_EPOCHS = 256n;
const PRUNE_EVERY_EPOCHS = 32n;

/** A device across accounts: `${userId}/${device}`. */
export const deviceAddress = (userId: string, device: string) => `${userId}/${device}`;

export class MlsDeliveryRefusal extends Error {
    constructor(readonly reason: "unknownDevice" | "tooManyKeyPackages" | "unknownGroup" | "groupExists" | "staleEpoch" | "treeMissing") {
        super(reason);
        this.name = "MlsDeliveryRefusal";
    }
}

/**
 * Record (or refresh) a device and the protocol version it declares.
 *
 * A device the account did not have, joining one it already had, tells the
 * account (docs/chat-e2ee-mls.md, "Device hygiene"): a new device reads every
 * sealed conversation from then on, so it is the one change worth hearing about
 * at once - the same alert WhatsApp and Signal raise for a linked device. The
 * account's first device says nothing (that is just turning sealed chat on), and
 * neither do the members the server runs, whose device registers on every act.
 * A browser signed out or removed that comes back is new again, and says so.
 */
export async function registerDevice(userId: string, device: string, signatureKey: Uint8Array, e2eeVersion: number): Promise<void> {
    const now = new Date();
    const known = await prisma.mlsDevice.findUnique({ where: { userId_device: { userId, device } }, select: { userId: true } });
    await prisma.mlsDevice.upsert({
        where: { userId_device: { userId, device } },
        create: { userId, device, signatureKey: Buffer.from(signatureKey), e2eeVersion, lastSeenAt: now },
        update: { signatureKey: Buffer.from(signatureKey), e2eeVersion, lastSeenAt: now }
    });
    if (known || SERVICE_ACCOUNT_IDS.includes(userId)) return;
    try {
        const others = await prisma.mlsDevice.count({ where: { userId, device: { not: device } } });
        if (others > 0) await (await import("@/lib/notifications/security-events")).notifySealedDeviceAdded(userId);
    } catch (caught) {
        // Telling the account is never worth failing the device it is about.
        console.error("polaris: could not raise the new sealed-chat device alert:", caught);
    }
}

/**
 * Days a device may go unseen before it counts as retired (decision 7 of
 * docs/chat-e2ee-proposal.md: 30 by default, 7 to 90): its leaves leave each
 * group at the next member's send and it is handed out to nobody new. It comes
 * back on its own the next time it opens - it registers again and rejoins each
 * conversation by an external commit, reading the past from its account's
 * history keys. WhatsApp logs a linked device out after 30 days unused, Signal
 * after 30 (the proposal cites 45); Matrix keeps devices until signed out.
 */
export const INACTIVE_DEVICE_DAYS = { fallback: 30, min: 7, max: 90 } as const;
export const INACTIVE_DEVICE_DAYS_SETTING = "chat.e2ee.inactiveDeviceDays";

/** The instance's limit, from `Setting` when an administrator set one, clamped to 7-90. */
export async function inactiveDeviceDays(): Promise<number> {
    return inactiveDaysFrom(await getSetting(INACTIVE_DEVICE_DAYS_SETTING).catch(() => null));
}

/** The limit a stored `Setting` value means: the default when unset or unreadable, else clamped to 7-90. */
export function inactiveDaysFrom(stored: string | null | undefined): number {
    const days = Number.parseInt(stored ?? "", 10);
    if (!Number.isFinite(days)) return INACTIVE_DEVICE_DAYS.fallback;
    return Math.min(INACTIVE_DEVICE_DAYS.max, Math.max(INACTIVE_DEVICE_DAYS.min, days));
}

/**
 * An account's limit: the instance's, or a tighter one any organization it
 * belongs to set (as owner or member). An organization may only shorten it - a
 * value at or above the instance's changes nothing - so the strictest applies.
 */
export function strictestDays(instance: number, orgDays: readonly (number | null | undefined)[]): number {
    const tighter = orgDays.filter((days): days is number => typeof days === "number" && Number.isFinite(days)).map((days) => inactiveDaysFrom(String(days)));
    return Math.min(instance, ...tighter);
}

/**
 * Each account's cutoff: the moment before which a device of it last seen
 * counts as retired. Two indexed reads whatever the number of accounts: their
 * memberships, then the organizations among those (or owned by them) that set a
 * limit.
 */
export async function inactiveCutoffs(userIds: readonly string[], now = Date.now()): Promise<Map<string, Date>> {
    const users = [...new Set(userIds)];
    const instance = await inactiveDeviceDays();
    const cutoffs = new Map(users.map((userId) => [userId, new Date(now - instance * 86_400_000)]));
    if (!users.length) return cutoffs;
    const memberships = await prisma.organizationMember.findMany({ where: { userId: { in: users } }, select: { userId: true, orgId: true } });
    const limited = await prisma.organization.findMany({
        where: { sealedDeviceDays: { not: null }, OR: [{ id: { in: [...new Set(memberships.map((m) => m.orgId))] } }, { ownerId: { in: users } }] },
        select: { id: true, ownerId: true, sealedDeviceDays: true }
    });
    if (!limited.length) return cutoffs;
    const days = new Map(limited.map((org) => [org.id, org.sealedDeviceDays]));
    for (const userId of users) {
        const own = [
            ...memberships.filter((m) => m.userId === userId).map((m) => days.get(m.orgId)),
            ...limited.filter((org) => org.ownerId === userId).map((org) => org.sealedDeviceDays)
        ];
        cutoffs.set(userId, new Date(now - strictestDays(instance, own) * 86_400_000));
    }
    return cutoffs;
}

/** A device's `lastSeenAt` moves at most this often from its ordinary traffic. */
const SEEN_EVERY_MS = 60 * 60_000;

/**
 * Note that the device is in use (any op it makes): one write an hour at most,
 * so a tab open for weeks never counts as inactive. False when the device is
 * unknown - never registered, or retired since.
 */
export async function touchDevice(userId: string, device: string, now = new Date()): Promise<boolean> {
    const row = await prisma.mlsDevice.findUnique({ where: { userId_device: { userId, device } }, select: { lastSeenAt: true } });
    if (!row) return false;
    if (now.getTime() - row.lastSeenAt.getTime() >= SEEN_EVERY_MS)
        await prisma.mlsDevice.updateMany({ where: { userId, device }, data: { lastSeenAt: now } });
    return true;
}

/**
 * Retire a device: the browser signed its account out. Its record and every
 * key package go, so nobody adds it again, and every group drops its leaf at
 * the next member's send (`retiredDevices`). Idempotent.
 */
export async function retireDevice(userId: string, device: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
        await tx.mlsKeyPackage.deleteMany({ where: { userId, device } });
        await tx.mlsDevice.deleteMany({ where: { userId, device } });
    });
}

/**
 * Of these device addresses (leaves of a group), the ones no longer in use:
 * retired, never known, or unseen since its account's cutoff (`inactiveCutoffs`).
 * A member the server runs (Polar, a webhook) is never one: its device lives on
 * the server and registers each time it acts, so a quiet month says nothing
 * about a lost device.
 */
export async function retiredDevices(addresses: readonly string[], now = Date.now()): Promise<string[]> {
    const services = new Set(SERVICE_ACCOUNT_IDS);
    const wanted = [...new Set(addresses)].filter((address) => !services.has(address.slice(0, address.indexOf("/"))));
    if (!wanted.length) return [];
    const parsed = wanted.map((address) => ({ address, userId: address.slice(0, address.indexOf("/")), device: address.slice(address.indexOf("/") + 1) }));
    const rows = await prisma.mlsDevice.findMany({
        where: { userId: { in: [...new Set(parsed.map((p) => p.userId))] }, device: { in: parsed.map((p) => p.device) } },
        select: { userId: true, device: true, lastSeenAt: true }
    });
    const cutoffs = await inactiveCutoffs(parsed.map((p) => p.userId), now);
    const live = new Set(rows.filter((r) => r.lastSeenAt >= cutoffs.get(r.userId)!).map((r) => deviceAddress(r.userId, r.device)));
    return parsed.filter((p) => !live.has(p.address)).map((p) => p.address);
}

/** How many one-use key packages of this device are still unclaimed, so it tops them up only when low. */
export async function heldKeyPackages(userId: string, device: string, ciphersuite: number): Promise<number> {
    return prisma.mlsKeyPackage.count({ where: { userId, device, ciphersuite, lastResort: false } });
}

/** Publish one-use key packages, or replace the device's last-resort one. */
export async function publishKeyPackages(
    userId: string,
    device: string,
    ciphersuite: number,
    packages: readonly Uint8Array[],
    lastResort: boolean
): Promise<void> {
    await prisma.$transaction(async (tx) => {
        const known = await tx.mlsDevice.findUnique({ where: { userId_device: { userId, device } }, select: { userId: true } });
        if (!known) throw new MlsDeliveryRefusal("unknownDevice");
        if (lastResort) await tx.mlsKeyPackage.deleteMany({ where: { userId, device, ciphersuite, lastResort: true } });
        else {
            const held = await tx.mlsKeyPackage.count({ where: { userId, device, lastResort: false } });
            if (held + packages.length > MAX_KEY_PACKAGES_PER_DEVICE) throw new MlsDeliveryRefusal("tooManyKeyPackages");
        }
        await tx.mlsKeyPackage.createMany({
            data: packages.map((keyPackage) => ({ userId, device, ciphersuite, keyPackage: Buffer.from(keyPackage), lastResort }))
        });
    });
}

/**
 * One key package for every device of each account, to add them to a group.
 * A one-use package is deleted as it is handed out (only one claimer can
 * delete a row, so a package is never given twice); a device with none left
 * answers with its last-resort package.
 */
export async function claimKeyPackages(
    userIds: readonly string[],
    ciphersuite: number
): Promise<{ address: string; keyPackage: Uint8Array }[]> {
    const users = [...new Set(userIds)].slice(0, MAX_CLAIM_USERS);
    const cutoffs = await inactiveCutoffs(users);
    const known = await prisma.mlsDevice.findMany({ where: { userId: { in: users } }, select: { userId: true, device: true, lastSeenAt: true } });
    // A device unseen past its account's limit is added to nothing new, and its packages go (it publishes fresh ones when it is back).
    const fresh = (d: { userId: string; lastSeenAt: Date }) => d.lastSeenAt >= cutoffs.get(d.userId)!;
    const stale = known.filter((d) => !fresh(d));
    for (const { userId, device } of stale) await prisma.mlsKeyPackage.deleteMany({ where: { userId, device } });
    const devices = known.filter(fresh);
    const out: { address: string; keyPackage: Uint8Array }[] = [];
    for (const { userId, device } of devices) {
        for (let attempt = 0; attempt < 3; attempt++) {
            const row = await prisma.mlsKeyPackage.findFirst({
                where: { userId, device, ciphersuite, lastResort: false },
                orderBy: { createdAt: "asc" },
                select: { id: true, keyPackage: true }
            });
            if (!row) {
                const fallback = await prisma.mlsKeyPackage.findFirst({
                    where: { userId, device, ciphersuite, lastResort: true },
                    select: { keyPackage: true }
                });
                if (fallback) out.push({ address: deviceAddress(userId, device), keyPackage: new Uint8Array(fallback.keyPackage) });
                break;
            }
            const taken = await prisma.mlsKeyPackage.deleteMany({ where: { id: row.id } });
            if (taken.count === 1) {
                out.push({ address: deviceAddress(userId, device), keyPackage: new Uint8Array(row.keyPackage) });
                break;
            }
        }
    }
    return out;
}

/** The conversation's group, made by the first device that sets it up. */
export async function createGroup(channelId: string, groupId: Uint8Array, ciphersuite: number, groupInfo: Uint8Array): Promise<void> {
    const existing = await prisma.mlsGroup.findUnique({ where: { channelId }, select: { channelId: true } });
    if (existing) throw new MlsDeliveryRefusal("groupExists");
    try {
        await prisma.mlsGroup.create({
            data: { channelId, groupId: Buffer.from(groupId), ciphersuite, epoch: 0n, groupInfo: Buffer.from(groupInfo) }
        });
    } catch {
        // The unique key lost a race with another device's create.
        throw new MlsDeliveryRefusal("groupExists");
    }
}

export async function groupState(channelId: string) {
    return prisma.mlsGroup.findUnique({
        where: { channelId },
        select: { groupId: true, ciphersuite: true, epoch: true, groupInfo: true }
    });
}

/** How many parts the tree of the group's current epoch is kept in; null while it rides inside the GroupInfo. */
export async function currentTreeParts(channelId: string, epoch: bigint): Promise<number | null> {
    const row = await prisma.mlsTreePart.findFirst({ where: { channelId, epoch, part: 0, committed: true }, select: { parts: true } });
    return row?.parts ?? null;
}

/**
 * Take a commit made in `epoch`: the group moves to `epoch + 1` and the commit,
 * then each Welcome, join the log - all or nothing. Refused with `staleEpoch`
 * when another commit got there first.
 */
export async function submitCommit(
    channelId: string,
    sender: string,
    epoch: bigint,
    commit: Uint8Array,
    welcomes: readonly { recipient: string; welcome: Uint8Array }[],
    groupInfo: Uint8Array,
    treeParts?: number
): Promise<{ epoch: bigint }> {
    return prisma.$transaction(async (tx) => {
        const moved = await tx.mlsGroup.updateMany({
            where: { channelId, epoch },
            data: { epoch: epoch + 1n, groupInfo: Buffer.from(groupInfo) }
        });
        if (moved.count !== 1) {
            const known = await tx.mlsGroup.findUnique({ where: { channelId }, select: { channelId: true } });
            throw new MlsDeliveryRefusal(known ? "staleEpoch" : "unknownGroup");
        }
        await tx.mlsGroupEvent.create({ data: { channelId, epoch, kind: "commit", sender, payload: Buffer.from(commit) } });
        const next = epoch + 1n;
        if (treeParts) {
            // The tree this commit left out, every part staged by the committer for the epoch it moves into.
            const staged = { channelId, epoch: next, sender, committed: false, parts: treeParts, part: { lt: treeParts } };
            if ((await tx.mlsTreePart.count({ where: staged })) !== treeParts) throw new MlsDeliveryRefusal("treeMissing");
            await tx.mlsTreePart.updateMany({ where: staged, data: { committed: true } });
        }
        // Staged parts nobody can commit any more (a lost race, a resend), and trees older than a Welcome still waits for.
        await tx.mlsTreePart.deleteMany({
            where: { channelId, OR: [{ committed: false, epoch: { lte: next } }, { epoch: { lte: next - TREE_EPOCHS } }] }
        });
        if (next % PRUNE_EVERY_EPOCHS === 0n && next > RETAINED_EPOCHS)
            await tx.mlsGroupEvent.deleteMany({ where: { channelId, epoch: { lt: next - RETAINED_EPOCHS } } });
        if (welcomes.length)
            await tx.mlsGroupEvent.createMany({
                data: welcomes.map(({ recipient, welcome }) => ({
                    channelId,
                    epoch: epoch + 1n,
                    kind: "welcome",
                    sender,
                    recipient,
                    payload: Buffer.from(welcome)
                }))
            });
        return { epoch: epoch + 1n };
    });
}

/**
 * Stage one part of the tree a large group's next commit leaves out
 * (`epoch` is the epoch that commit moves into). Overwrites this device's own
 * earlier upload of that part, so a retry or a resend never piles up; the
 * commit promotes the parts and drops every other staged one.
 */
export async function putTreePart(channelId: string, sender: string, epoch: bigint, part: number, parts: number, bytes: Uint8Array): Promise<void> {
    if (part >= parts) throw new MlsDeliveryRefusal("treeMissing");
    const group = await prisma.mlsGroup.findUnique({ where: { channelId }, select: { epoch: true } });
    if (!group) throw new MlsDeliveryRefusal("unknownGroup");
    if (epoch !== group.epoch + 1n) throw new MlsDeliveryRefusal("staleEpoch");
    const data = { parts, bytes: Buffer.from(bytes), committed: false, createdAt: new Date() };
    await prisma.mlsTreePart.upsert({
        where: { channelId_epoch_sender_part: { channelId, epoch, sender, part } },
        create: { channelId, epoch, sender, part, ...data },
        update: data
    });
}

/** One part of the tree kept for `epoch`, and how many there are; null when that epoch's tree is inline or gone. */
export async function readTreePart(channelId: string, epoch: bigint, part: number): Promise<{ parts: number; bytes: Uint8Array } | null> {
    const row = await prisma.mlsTreePart.findFirst({ where: { channelId, epoch, part, committed: true }, select: { parts: true, bytes: true } });
    return row && { parts: row.parts, bytes: new Uint8Array(row.bytes) };
}

/** An MLS application message (a history key, a control message) for the whole group. */
export async function sendApplication(channelId: string, sender: string, epoch: bigint, payload: Uint8Array): Promise<void> {
    const group = await prisma.mlsGroup.findUnique({ where: { channelId }, select: { epoch: true } });
    if (!group) throw new MlsDeliveryRefusal("unknownGroup");
    if (epoch > group.epoch) throw new MlsDeliveryRefusal("staleEpoch");
    await prisma.mlsGroupEvent.create({ data: { channelId, epoch, kind: "application", sender, payload: Buffer.from(payload) } });
}

/** The group's log after `afterSeq` that this device may read, in order. */
export async function readEvents(channelId: string, address: string, afterSeq: bigint, limit = MAX_EVENTS_PER_READ) {
    const rows = await prisma.mlsGroupEvent.findMany({
        where: { channelId, seq: { gt: afterSeq }, OR: [{ recipient: null }, { recipient: address }] },
        orderBy: { seq: "asc" },
        take: Math.min(Math.max(1, limit), MAX_EVENTS_PER_READ),
        select: { seq: true, epoch: true, kind: true, sender: true, payload: true }
    });
    return rows.map((row) => ({ ...row, payload: new Uint8Array(row.payload) }));
}

/**
 * Up to `limit` of these accounts that have a device with a key package in
 * this suite, so adding them to a group has something to claim. Reads a
 * bounded number of rows: an account not reached this time is reached once
 * the ones before it are in the group and no longer asked about.
 */
export async function accountsWithKeyPackages(userIds: readonly string[], ciphersuite: number, limit: number): Promise<string[]> {
    if (!userIds.length) return [];
    const rows = await prisma.mlsKeyPackage.findMany({
        where: { userId: { in: [...new Set(userIds)] }, ciphersuite },
        select: { userId: true },
        take: MAX_KEY_PACKAGE_ROWS
    });
    return [...new Set(rows.map((row) => row.userId))].slice(0, limit);
}

/** The public halves of these accounts' keys; accounts without one are left out. */
export async function accountPublicKeys(userIds: readonly string[]) {
    return prisma.chatAccountKey.findMany({
        where: { userId: { in: [...new Set(userIds)].slice(0, MAX_CLAIM_USERS) } },
        select: { userId: true, akVersion: true, signPublicKey: true, hpkePublicKey: true }
    });
}

/** Store history-key envelopes; one per (epoch, recipient), the first written wins. */
export async function putHistoryKeys(
    channelId: string,
    epoch: bigint,
    envelopes: readonly { recipient: string; envelope: Uint8Array }[]
): Promise<void> {
    await prisma.chatHistoryKey.createMany({
        data: envelopes.map(({ recipient, envelope }) => ({ channelId, epoch, recipient, envelope: Buffer.from(envelope) })),
        skipDuplicates: true
    });
}

/** Whether `recipient` has an envelope of the conversation's history key for `epoch`. */
export async function holdsHistoryKey(channelId: string, epoch: bigint, recipient: string): Promise<boolean> {
    const row = await prisma.chatHistoryKey.findUnique({ where: { channelId_epoch_recipient: { channelId, epoch, recipient } }, select: { recipient: true } });
    return row !== null;
}

/** Server-sealed epochs `serverSealedEpochs` answers per call. */
export const GAP_EPOCHS = 8;

/**
 * The epochs at or below `upTo` whose history key the server sealed and then
 * forgot that `recipient` holds an envelope of, highest first, at most
 * `limit`: the migration's (`LEGACY_EPOCH`) and each annotation sweep's
 * (`SWEEP_EPOCH_FLOOR` .. `SWEEP_EPOCH_TOP`, which sit right below it). Only a
 * holder can pass such a key on, since nobody else, the server included, has it.
 */
export async function serverSealedEpochs(channelId: string, recipient: string, upTo?: bigint, limit = GAP_EPOCHS): Promise<bigint[]> {
    const rows = await prisma.chatHistoryKey.findMany({
        where: { channelId, recipient, epoch: upTo === undefined ? { gte: SWEEP_EPOCH_FLOOR } : { gte: SWEEP_EPOCH_FLOOR, lte: upTo } },
        orderBy: { epoch: "desc" },
        select: { epoch: true },
        take: limit
    });
    return rows.map((row) => row.epoch);
}

/** Audience ids `legacyKeyGaps` checks per round trip. */
const GAP_SCAN = 500;

/**
 * The public account keys of `audience` members with no envelope of the
 * conversation's history key for `epoch`, at most `limit` of them: who a
 * member holding that key still has to seal it to. Members with no account key
 * are not listed - there is nothing to seal to yet.
 */
export async function legacyKeyGaps(channelId: string, epoch: bigint, audience: readonly string[], limit = MAX_CLAIM_USERS) {
    const found: { userId: string; akVersion: number; hpkePublicKey: Uint8Array }[] = [];
    for (let at = 0; at < audience.length && found.length < limit; at += GAP_SCAN) {
        const slice = audience.slice(at, at + GAP_SCAN);
        const held = await prisma.chatHistoryKey.findMany({ where: { channelId, epoch, recipient: { in: slice } }, select: { recipient: true } });
        const have = new Set(held.map((row) => row.recipient));
        const missing = slice.filter((id) => !have.has(id));
        for (let from = 0; from < missing.length && found.length < limit; from += MAX_CLAIM_USERS) {
            const keys = await prisma.chatAccountKey.findMany({
                where: { userId: { in: missing.slice(from, from + MAX_CLAIM_USERS) } },
                select: { userId: true, akVersion: true, hpkePublicKey: true }
            });
            for (const key of keys) if (found.length < limit) found.push({ userId: key.userId, akVersion: key.akVersion, hpkePublicKey: new Uint8Array(key.hpkePublicKey) });
        }
    }
    return found;
}

/** Every history-key envelope sealed to this recipient in the conversation, oldest epoch first. */
export async function historyKeys(channelId: string, recipient: string, fromEpoch = 0n, limit = MAX_EVENTS_PER_READ) {
    const rows = await prisma.chatHistoryKey.findMany({
        where: { channelId, recipient, epoch: { gte: fromEpoch } },
        orderBy: { epoch: "asc" },
        take: Math.min(Math.max(1, limit), MAX_EVENTS_PER_READ),
        select: { epoch: true, envelope: true }
    });
    return rows.map((row) => ({ epoch: row.epoch, envelope: new Uint8Array(row.envelope) }));
}
