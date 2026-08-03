/**
 * Which storage a kind of upload is written to.
 *
 * Polaris already knows how to reach a NAS over SMB, an NFS export or an SFTP
 * host, so nothing that accepts a file needs a second way of writing bytes. It
 * needs a decision: which of those, or the disk Polaris itself runs on. That
 * decision is one setting per kind of upload - files attached to work, profile
 * photos - and until an administrator makes it the answer is the obvious one: a
 * NAS if this instance has one, because that is the disk with the room and the
 * backups, otherwise the disk next to Polaris's own data.
 *
 * The choice is re-read on every write rather than frozen, so connecting a NAS
 * later moves new files onto it without a migration. What is already stored
 * records the connection it was written to and stays readable where it is.
 */

import { prisma } from "@polaris/db";
import { mkdir } from "node:fs/promises";
import { loadEnv } from "@polaris/config";
import { LocalDriver } from "@polaris/storage";
import { getSetting } from "@/lib/setting-store";
import type { StorageDriver } from "@polaris/storage";
import { getDriverForConnection } from "@/lib/storage-service";

/** Chosen by nobody, so chosen by the rule below. */
export const AUTOMATIC_TARGET = "auto";
/** The disk Polaris runs on. */
export const LOCAL_TARGET = "local";

/** The kinds that mean "a box built to hold files", in the order they are
 *  preferred when nobody has chosen. */
const NAS_KINDS = ["unifi-unas", "smb", "nfs"] as const;

export interface UploadTarget {
    /** A storage connection id, or `local`. */
    readonly id: string;
    readonly name: string;
    /** True when this was worked out rather than chosen. */
    readonly automatic: boolean;
}

/** A connection an administrator can point uploads at. */
export interface TargetOption {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
}

/**
 * Where a given kind of upload should go right now.
 *
 * A connection somebody deleted must not stop uploads: rather than failing every
 * write from then on, the setting falls through to the automatic rule.
 */
export async function resolveStorageTarget(settingKey: string): Promise<UploadTarget> {
    const choice = (await getSetting(settingKey)) ?? AUTOMATIC_TARGET;
    if (choice === LOCAL_TARGET) return { id: LOCAL_TARGET, name: "This server", automatic: false };
    if (choice !== AUTOMATIC_TARGET) {
        const chosen = await prisma.storageConnection.findUnique({
            where: { id: choice },
            select: { id: true, name: true }
        });
        if (chosen) return { id: chosen.id, name: chosen.name, automatic: false };
    }

    const connections = await prisma.storageConnection.findMany({
        where: { kind: { in: [...NAS_KINDS] } },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, kind: true }
    });
    for (const kind of NAS_KINDS) {
        const match = connections.find((connection) => connection.kind === kind);
        if (match) return { id: match.id, name: match.name, automatic: true };
    }
    return { id: LOCAL_TARGET, name: "This server", automatic: true };
}

/** Everything an administrator may point uploads at, for the settings screen. */
export function storageTargetOptions(): Promise<TargetOption[]> {
    return prisma.storageConnection.findMany({
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, kind: true }
    });
}

/**
 * A driver onto whichever storage a target names.
 *
 * `localFolder` is the folder under POLARIS_DATA_DIR used when the target is
 * this server. The local driver refuses a root that is not there, and on a fresh
 * install it is not there until the first file arrives - so the folder is made
 * here rather than left to whoever installs Polaris.
 */
export async function driverForTarget(targetId: string, localFolder: string): Promise<StorageDriver> {
    if (targetId === LOCAL_TARGET) {
        const root = `${loadEnv().POLARIS_DATA_DIR}/${localFolder}`;
        await mkdir(root, { recursive: true });
        const driver = new LocalDriver({ id: LOCAL_TARGET, root });
        await driver.connect();
        return driver;
    }
    return getDriverForConnection(targetId);
}

/**
 * A file name that is safe on every backend Polaris writes to.
 *
 * Windows, SMB and every archive tool disagree about what a name may contain, so
 * a stored name is reduced to the characters they all accept. The name somebody
 * typed is kept in the database and used on the way out, so nothing a person
 * reads is affected by this.
 */
export function safeName(name: string): string {
    const cleaned = name
        // An allowlist rather than a list of what to strip: the set of things
        // some filesystem objects to is open-ended, and the set that is safe
        // everywhere is short.
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^[.-]+/, "")
        .replace(/-{2,}/g, "-");
    return cleaned.slice(0, 120) || "file";
}
