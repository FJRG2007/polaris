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

export const MAX_KEY_PACKAGES_PER_DEVICE = 100;
export const MAX_CLAIM_USERS = 100;
export const MAX_EVENTS_PER_READ = 200;
export const MAX_WELCOMES_PER_COMMIT = 100;

/** A device across accounts: `${userId}/${device}`. */
export const deviceAddress = (userId: string, device: string) => `${userId}/${device}`;

export class MlsDeliveryRefusal extends Error {
    constructor(readonly reason: "unknownDevice" | "tooManyKeyPackages" | "unknownGroup" | "groupExists" | "staleEpoch") {
        super(reason);
        this.name = "MlsDeliveryRefusal";
    }
}

/** Record (or refresh) a device and the protocol version it declares. */
export async function registerDevice(userId: string, device: string, signatureKey: Uint8Array, e2eeVersion: number): Promise<void> {
    const now = new Date();
    await prisma.mlsDevice.upsert({
        where: { userId_device: { userId, device } },
        create: { userId, device, signatureKey: Buffer.from(signatureKey), e2eeVersion, lastSeenAt: now },
        update: { signatureKey: Buffer.from(signatureKey), e2eeVersion, lastSeenAt: now }
    });
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
    const devices = await prisma.mlsDevice.findMany({ where: { userId: { in: users } }, select: { userId: true, device: true } });
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
    groupInfo: Uint8Array
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
