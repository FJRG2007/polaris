/**
 * The tracker connections themselves: what is connected, and the credential
 * behind it.
 *
 * Deliberately knows nothing about tasks. The pull lives in `sync.ts` and the
 * push in `push.ts`, and both of them come through here for a credential - which
 * is what keeps the task layer and this one from importing each other in a
 * circle, and what makes "where is the secret read" a question with one answer.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { loadEnv } from "@polaris/config";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { trackerClient, type TrackerCredential } from "./providers";

export interface TrackerView {
    readonly id: string;
    readonly provider: core.IssueTracker;
    readonly label: string;
    readonly spaceId: string;
    readonly spaceName: string;
    readonly listId: string;
    readonly listName: string;
    readonly query: string;
    /** The non-secret half, for the form. Never the secret. */
    readonly config: Record<string, string>;
    readonly enabled: boolean;
    readonly pushStatus: boolean;
    readonly linked: number;
    readonly syncedAt: string | null;
    readonly error: string | null;
}

/** Every connection this account owns. */
export async function listTrackers(ownerId: string): Promise<TrackerView[]> {
    const rows = await prisma.taskTracker.findMany({
        where: { ownerId },
        orderBy: { createdAt: "asc" },
        select: {
            id: true,
            provider: true,
            label: true,
            spaceId: true,
            listId: true,
            query: true,
            config: true,
            enabled: true,
            pushStatus: true,
            syncedAt: true,
            error: true,
            space: { select: { name: true } },
            _count: { select: { links: true } }
        }
    });

    const listIds = rows.map((row) => row.listId);
    const lists = await prisma.taskList.findMany({
        where: { id: { in: listIds } },
        select: { id: true, name: true }
    });
    const listName = new Map(lists.map((list) => [list.id, list.name]));

    return rows.map((row) => ({
        id: row.id,
        provider: core.isIssueTracker(row.provider) ? row.provider : "linear",
        label: row.label,
        spaceId: row.spaceId,
        spaceName: row.space.name,
        listId: row.listId,
        listName: listName.get(row.listId) ?? "a list that is gone",
        query: row.query,
        config: readConfig(row.config),
        enabled: row.enabled,
        pushStatus: row.pushStatus,
        linked: row._count.links,
        syncedAt: row.syncedAt?.toISOString() ?? null,
        error: row.error
    }));
}

function readConfig(raw: string): Record<string, string> {
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object") return {};
        const config: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof value === "string") config[key] = value;
        }
        return config;
    } catch {
        return {};
    }
}

export interface SaveTrackerInput {
    readonly id: string | null;
    readonly provider: core.IssueTracker;
    readonly label: string;
    readonly spaceId: string;
    readonly listId: string;
    readonly query: string;
    readonly config: Record<string, string>;
    /** Empty leaves whatever is stored, so editing a connection does not require
     *  re-pasting a token the operator no longer has. */
    readonly secret: string;
    readonly pushStatus: boolean;
}

export async function saveTracker(ownerId: string, input: SaveTrackerInput): Promise<string> {
    const sealed = input.secret ? encryptSecret(input.secret, loadEnv().POLARIS_MASTER_KEY) : null;
    const data = {
        ownerId,
        provider: input.provider,
        label: input.label,
        spaceId: input.spaceId,
        listId: input.listId,
        query: input.query,
        config: JSON.stringify(input.config),
        pushStatus: input.pushStatus,
        ...(sealed
            ? {
                  encryptedSecret: sealed.ciphertext,
                  secretNonce: sealed.nonce,
                  secretKeyId: sealed.keyId
              }
            : {})
    };

    if (input.id) {
        const existing = await prisma.taskTracker.findFirst({
            where: { id: input.id, ownerId },
            select: { id: true }
        });
        if (!existing) throw new Error("That connection is not one of yours.");
        await prisma.taskTracker.update({ where: { id: input.id }, data });
        return input.id;
    }
    if (!sealed) throw new Error("A new connection needs its key or token.");
    const created = await prisma.taskTracker.create({ data, select: { id: true } });
    return created.id;
}

export async function deleteTracker(ownerId: string, trackerId: string): Promise<void> {
    // The links go with it and the tasks stay. A task that was mirrored is still
    // work somebody may be part-way through, and deleting a connection is not a
    // statement about the work.
    await prisma.taskTracker.deleteMany({ where: { id: trackerId, ownerId } });
}

export async function setTrackerEnabled(
    ownerId: string,
    trackerId: string,
    enabled: boolean
): Promise<void> {
    await prisma.taskTracker.updateMany({ where: { id: trackerId, ownerId }, data: { enabled } });
}

/**
 * The credential a connection holds, decrypted.
 *
 * Unscoped by design and never reachable from a route: the two callers are the
 * pull and the push, both of which have already resolved the connection through
 * its owner. It is here rather than beside them so a secret is read in exactly
 * one place.
 */
export async function credentialFor(trackerId: string): Promise<TrackerCredential | null> {
    const row = await prisma.taskTracker.findUnique({
        where: { id: trackerId },
        select: {
            provider: true,
            query: true,
            config: true,
            encryptedSecret: true,
            secretNonce: true,
            secretKeyId: true
        }
    });
    if (!row?.encryptedSecret || !row.secretNonce || !row.secretKeyId) return null;
    if (!core.isIssueTracker(row.provider)) return null;
    const secret = decryptSecret(
        {
            ciphertext: Buffer.from(row.encryptedSecret),
            nonce: Buffer.from(row.secretNonce),
            keyId: row.secretKeyId
        },
        loadEnv().POLARIS_MASTER_KEY
    );
    return { provider: row.provider, config: readConfig(row.config), secret, query: row.query };
}

/** Ask the tracker whether the credential works, without changing anything. */
export async function checkTracker(
    ownerId: string,
    trackerId: string
): Promise<{ ok: boolean; detail: string }> {
    const owned = await prisma.taskTracker.findFirst({
        where: { id: trackerId, ownerId },
        select: { id: true }
    });
    if (!owned) return { ok: false, detail: "That connection is not one of yours." };
    const credential = await credentialFor(trackerId);
    if (!credential) return { ok: false, detail: "That connection has no key stored on it." };
    try {
        return await trackerClient(credential).check();
    } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : "It did not answer." };
    }
}

/** Record how a pass went, on the connection rather than in a log. */
export async function noteSync(trackerId: string, error: string | null): Promise<void> {
    await prisma.taskTracker.update({
        where: { id: trackerId },
        data: { syncedAt: new Date(), error }
    });
}
