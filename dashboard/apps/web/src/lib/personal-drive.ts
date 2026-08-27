/**
 * Everybody's own drive.
 *
 * Until now Drive browsed storages an administrator had connected, which meant
 * an account with none of its own opened Drive and found nothing there. This is
 * the other half: a folder that belongs to one person, made the first time they
 * open Drive, that nobody else can reach unless they are given it.
 *
 * It is a StorageConnection row rather than a new kind of thing. Everything
 * Drive hangs off a connection - who may open which folder, what was shared out
 * of it, what is in its bin, which items were starred, what somebody asked to
 * have dropped into it - is keyed by a connection id, and a personal drive needs
 * all of it. The alternative, an id with a prefix the way a server or a
 * container is browsed, would have had to reproduce every one of those (and
 * cannot: those columns hold a uuid). So the row exists, and none of that code
 * learns anything new.
 *
 * What it is NOT is a storage somebody connected: it carries no credentials (it
 * borrows the storage it sits on), it cannot be created, edited or removed from
 * the connection screens, and it is kept out of every list that offers a storage
 * for something else to use - upload destinations, backup destinations, deploy
 * volumes. A person's room is not a disk the instance may fill.
 */

import { prisma } from "@polaris/db";
import type { StorageDriver } from "@polaris/storage";
import { getSetting, setSetting } from "@/lib/setting-store";
import { LOCAL_TARGET, PERSONAL_KIND, type StorageConfig } from "@polaris/core";
import { getDriverForConnection, PERSONAL_LOCAL_FOLDER } from "@/lib/storage-service";
import {
    AUTOMATIC_TARGET,
    resolveStorageTarget,
    storageTargetOptions,
    type TargetOption,
    type UploadTarget
} from "@/lib/storage-target";

/** What a personal drive is called wherever storages are listed by name. */
export const PERSONAL_DRIVE_NAME = "My files";

/**
 * The one refusal a caller is expected to show somebody.
 *
 * A drive is looked up by an id that is an account's, so the only way it can
 * fail to open other than a broken database is a row under that id that is not
 * this account's drive. That is worth saying on the screen; everything else that
 * can go wrong in here is a storage or a query failing, and its message belongs
 * in the log rather than in front of a reader who cannot act on it.
 */
export const PERSONAL_DRIVE_TAKEN = "This account's drive cannot be opened";

/** Where a personal drive made from now on is put. Its own setting, beside the
 *  other upload destinations on /admin/uploads: people's files are the biggest
 *  thing this instance will ever hold, and the disk that suits them is not
 *  necessarily the one holding profile photos. */
export const PERSONAL_TARGET_KEY = "drive.personal.target";

/**
 * The connection id of somebody's own drive, which is their own account id.
 *
 * A drive is one per account and is looked up on nearly every Drive request, so
 * deriving the id rather than storing a pointer saves a query everywhere and,
 * more usefully, makes provisioning a single upsert: two requests arriving at
 * once for a brand-new account cannot end up making two drives and splitting
 * somebody's files between them.
 *
 * Sharing the value with the account is safe because ids are never compared
 * across tables, and it reads correctly in the one place it surfaces: the drive
 * whose id is yours is yours.
 */
export function personalDriveId(userId: string): string {
    return userId;
}

/** Whether a connection id names a personal drive - which is the same question
 *  as whether it is this account's own, since only one account has that id. */
export function isPersonalDriveOf(connectionId: string, userId: string): boolean {
    return connectionId === personalDriveId(userId);
}

/**
 * Where inside a storage one person's drive lives.
 *
 * On the disk Polaris runs on the driver is already rooted at the drive folder,
 * so only the account's own folder is left. On a storage shared with whatever
 * else is on it, everything Polaris keeps goes under one name so an operator
 * looking at their NAS can see what is ours and what is theirs.
 */
function rootFor(targetId: string, userId: string): string {
    return targetId === LOCAL_TARGET
        ? `people/${userId}`
        : `polaris/${PERSONAL_LOCAL_FOLDER}/people/${userId}`;
}

export interface PersonalDrive {
    readonly id: string;
    readonly name: string;
    /** The storage the files are on: a connection id, or `local`. */
    readonly targetId: string;
    /** The folder inside that storage. */
    readonly root: string;
}

function driveOf(row: { id: string; name: string; config: string }): PersonalDrive | null {
    try {
        const config = JSON.parse(row.config) as StorageConfig;
        if (config.kind !== PERSONAL_KIND) return null;
        return { id: row.id, name: row.name, targetId: config.targetId, root: config.root };
    } catch {
        return null;
    }
}

/**
 * This account's drive, made if it does not exist yet.
 *
 * Nothing has to be installed, configured or written into a file for this to
 * work: the storage it goes on is the one the instance already writes uploads
 * to, which on an install with a NAS is the NAS and on one without is the disk
 * Polaris runs on. That is what makes a personal drive appear on deployments
 * that were installed long before this existed.
 *
 * Where it landed is then recorded and never worked out again. An operator who
 * connects a NAS next month moves NEW drives onto it; the ones already made stay
 * readable where their files actually are.
 */
export async function ensurePersonalDrive(userId: string): Promise<PersonalDrive> {
    const id = personalDriveId(userId);
    const existing = await prisma.storageConnection.findUnique({
        where: { id },
        select: { id: true, name: true, config: true, kind: true, ownerId: true }
    });
    if (existing) {
        // The id is an account's, so a row under it can only be that account's
        // own drive. A row that is neither is a collision nobody should ever see
        // and is not something to quietly write over.
        const drive = existing.ownerId === userId ? driveOf(existing) : null;
        if (drive) return drive;
        throw new Error(PERSONAL_DRIVE_TAKEN);
    }

    const target = await resolveStorageTarget(PERSONAL_TARGET_KEY);
    const config: Extract<StorageConfig, { kind: "personal" }> = {
        kind: PERSONAL_KIND,
        targetId: target.id,
        root: rootFor(target.id, userId)
    };
    const row = await prisma.storageConnection.upsert({
        where: { id },
        update: {},
        create: {
            id,
            name: PERSONAL_DRIVE_NAME,
            kind: PERSONAL_KIND,
            ownerId: userId,
            config: JSON.stringify(config),
            requiresHostd: false
        },
        select: { id: true, name: true, config: true }
    });
    return driveOf(row) ?? { id, name: PERSONAL_DRIVE_NAME, ...config };
}

/** This account's drive if it has one, without making it. For the paths that
 *  only want to know - a listing, a share being resolved - and must not write. */
export async function findPersonalDrive(userId: string): Promise<PersonalDrive | null> {
    const row = await prisma.storageConnection.findFirst({
        where: { id: personalDriveId(userId), ownerId: userId, kind: PERSONAL_KIND },
        select: { id: true, name: true, config: true }
    });
    return row ? driveOf(row) : null;
}

/** Whose drive a connection is, or null when it is not one. */
export async function personalDriveOwner(connectionId: string): Promise<string | null> {
    const row = await prisma.storageConnection.findUnique({
        where: { id: connectionId },
        select: { kind: true, ownerId: true }
    });
    return row && row.kind === PERSONAL_KIND ? row.ownerId : null;
}

/** A connected driver onto this account's drive, making the drive if needed. */
export async function personalDriveDriver(userId: string): Promise<StorageDriver> {
    const drive = await ensurePersonalDrive(userId);
    return getDriverForConnection(drive.id);
}

export interface PersonalDriveSettings {
    /** What is stored: a connection id, `local`, or `auto`. */
    readonly choice: string;
    /** What that currently resolves to for a drive made now. */
    readonly resolved: UploadTarget;
    /** The storages an administrator can pick from. */
    readonly options: TargetOption[];
    /** How many drives already exist, and how they are spread over storages -
     *  because changing this setting moves nothing that is already somewhere. */
    readonly existing: ReadonlyArray<{ targetId: string; count: number }>;
}

/** What the uploads screen shows and edits for personal drives. */
export async function personalDriveSettings(): Promise<PersonalDriveSettings> {
    const [choice, resolved, options, drives] = await Promise.all([
        getSetting(PERSONAL_TARGET_KEY),
        resolveStorageTarget(PERSONAL_TARGET_KEY),
        storageTargetOptions(),
        prisma.storageConnection.findMany({
            where: { kind: PERSONAL_KIND },
            select: { config: true }
        })
    ]);

    const counts = new Map<string, number>();
    for (const row of drives) {
        const drive = driveOf({ id: "", name: "", config: row.config });
        if (!drive) continue;
        counts.set(drive.targetId, (counts.get(drive.targetId) ?? 0) + 1);
    }

    return {
        choice: choice ?? AUTOMATIC_TARGET,
        resolved,
        options,
        existing: [...counts].map(([targetId, count]) => ({ targetId, count }))
    };
}

/** Point drives made from now on at a storage. */
export async function setPersonalDriveTarget(target: string): Promise<void> {
    await setSetting(PERSONAL_TARGET_KEY, target);
}

/**
 * Take somebody's files off the disk, before the row that says where they are
 * goes with the account.
 *
 * Deleting an account cascades the drive's row away, and a cascade takes rows,
 * not bytes: without this, a deleted person's whole drive stays on the NAS with
 * nothing left anywhere that knows it is theirs or that it is there at all.
 *
 * Answers what it could not remove rather than throwing. A storage that is away
 * must not be able to block a deletion somebody asked for - the account still
 * goes, and what was left behind is named in the audit entry so an operator can
 * go and take it out by hand.
 */
export async function discardPersonalDrive(userId: string): Promise<string | null> {
    const drive = await findPersonalDrive(userId);
    if (!drive) return null;

    let driver;
    try {
        driver = await getDriverForConnection(drive.id);
    } catch (caught) {
        return `${drive.root}: ${caught instanceof Error ? caught.message : "could not be reached"}`;
    }
    try {
        // Everything inside it, one level in: the drive's own folder is exactly
        // what the driver refuses to remove, and it is left for the storage's
        // owner to sweep up empty.
        //
        // To the end of the listing, not the first page of it: a bucket answers
        // a thousand keys at a time, and stopping there would leave the rest of
        // somebody's files on the disk while reporting that nothing was left.
        let cursor: string | undefined;
        do {
            const page = await driver.list("", { cursor });
            for (const entry of page.entries) {
                await driver.delete(entry.path, { recursive: true });
            }
            cursor = page.nextCursor;
        } while (cursor);
        return null;
    } catch (caught) {
        return `${drive.root}: ${caught instanceof Error ? caught.message : "could not be emptied"}`;
    } finally {
        await driver.dispose().catch(() => undefined);
    }
}
