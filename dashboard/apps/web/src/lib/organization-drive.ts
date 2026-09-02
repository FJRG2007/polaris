/**
 * An organization's own Drive.
 *
 * The company's shelf, beside everybody's personal one: the contracts, the
 * policies, the things that belong to the business rather than to whoever
 * happened to upload them. Somebody's own account is the wrong place for those,
 * and not as a matter of tidiness - files kept there die with the account, count
 * against that person's space, and do not move when the organization is handed
 * on.
 *
 * It is the same shape a personal drive is, deliberately: a StorageConnection
 * row whose id is the organization's id, of the kind Polaris makes rather than
 * one anybody connects. Everything Drive hangs off a connection - who may open
 * which folder, what was shared out of it, what is in its bin, what was starred,
 * who uploaded each item - is keyed by a connection id, so none of that code
 * learns anything new. What differs is one column: this row carries an
 * organization id where a personal drive carries an account id.
 *
 * That column is why `ownerId` had to become nullable, and it is worth being
 * plain about. Pointing it at whoever owns the organization today would mean
 * deleting that person deletes the company's files, and it would go stale the
 * moment the organization is handed on - a transfer moves one column on the
 * organization and would leave the drive still naming the person who left.
 *
 * WHO MAY OPEN IT is deliberately not a new permission. Being on the roster is
 * enough to read, because a permission nobody's role holds yet is a feature that
 * is switched off on every organization that already exists, with no screen
 * telling anybody why. Writing is a permission, so a member cannot quietly
 * replace the company's documents; and the per-folder access rules Drive already
 * has are what narrows anything sensitive further, which is what somebody
 * putting legal papers in here is going to want for the folder they are in.
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

/** Where an organization's drive made from now on is put. Its own setting beside
 *  the personal one, because a company's document store and a hundred people's
 *  photographs do not necessarily belong on the same disk. */
export const ORGANIZATION_TARGET_KEY = "drive.organization.target";

/** The one refusal worth putting on a screen: a row under the organization's id
 *  that is not the organization's drive. Everything else that can go wrong in
 *  here is a storage failing, and its message belongs in the log. */
export const ORGANIZATION_DRIVE_TAKEN = "This organization's drive cannot be opened";

/**
 * The connection id of an organization's drive, which is the organization's own
 * id.
 *
 * The same trick a personal drive uses and for the same reasons: no pointer to
 * look up on every request, and provisioning is a single upsert, so two people
 * opening Drive at the same moment on a brand-new organization cannot end up
 * making two drives and splitting the company's files between them.
 */
export function organizationDriveId(orgId: string): string {
    return orgId;
}

/**
 * Where inside a storage one organization's drive lives.
 *
 * Beside `people/`, under a name that says what it is, so an operator looking at
 * their NAS can see whose files are whose. On the disk Polaris runs on the
 * driver is already rooted at the drive folder, so only the organization's own
 * folder is left.
 */
function rootFor(targetId: string, orgId: string): string {
    return targetId === LOCAL_TARGET
        ? `orgs/${orgId}`
        : `polaris/${PERSONAL_LOCAL_FOLDER}/orgs/${orgId}`;
}

export interface OrganizationDrive {
    readonly id: string;
    readonly name: string;
    /** The storage the files are on: a connection id, or `local`. */
    readonly targetId: string;
    /** The folder inside that storage. */
    readonly root: string;
}

function driveOf(row: { id: string; name: string; config: string }): OrganizationDrive | null {
    try {
        const config = JSON.parse(row.config) as StorageConfig;
        if (config.kind !== PERSONAL_KIND) return null;
        return { id: row.id, name: row.name, targetId: config.targetId, root: config.root };
    } catch {
        return null;
    }
}

/** What the drive is called wherever storages are listed by name. The
 *  organization's own name, so somebody in two of them can tell which shelf they
 *  are looking at. */
export function organizationDriveName(orgName: string): string {
    return `${orgName} files`;
}

/**
 * This organization's drive, made if it does not exist yet.
 *
 * Nothing has to be installed or configured for this to work: the storage it
 * goes on is the one the instance already writes uploads to, which is what makes
 * it appear on deployments installed long before this existed. Where it landed
 * is then recorded and never worked out again, so an operator who connects a NAS
 * next month moves NEW drives onto it and leaves the ones already made readable
 * where their files actually are.
 */
export async function ensureOrganizationDrive(orgId: string): Promise<OrganizationDrive> {
    const id = organizationDriveId(orgId);
    const [existing, org] = await Promise.all([
        prisma.storageConnection.findUnique({
            where: { id },
            select: { id: true, name: true, config: true, kind: true, orgId: true }
        }),
        prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } })
    ]);
    if (!org) throw new Error(ORGANIZATION_DRIVE_TAKEN);
    const name = organizationDriveName(org.name);

    if (existing) {
        // The id is an organization's, so a row under it can only be that
        // organization's drive. A row that is neither is a collision nobody
        // should ever see, and is not something to quietly write over.
        const drive = existing.orgId === orgId ? driveOf(existing) : null;
        if (!drive) throw new Error(ORGANIZATION_DRIVE_TAKEN);
        // A renamed organization renames its shelf. Cheap, and the alternative
        // is a company that changed its name still filing things under the old
        // one forever.
        if (drive.name !== name) {
            await prisma.storageConnection.update({ where: { id }, data: { name } });
            return { ...drive, name };
        }
        return drive;
    }

    const target = await resolveStorageTarget(ORGANIZATION_TARGET_KEY);
    const config: Extract<StorageConfig, { kind: "personal" }> = {
        kind: PERSONAL_KIND,
        targetId: target.id,
        root: rootFor(target.id, orgId)
    };
    const row = await prisma.storageConnection.upsert({
        where: { id },
        update: {},
        create: {
            id,
            name,
            kind: PERSONAL_KIND,
            orgId,
            config: JSON.stringify(config),
            requiresHostd: false
        },
        select: { id: true, name: true, config: true }
    });
    return driveOf(row) ?? { id, name, ...config };
}

/** This organization's drive if it has one, without making it. For the paths
 *  that only want to know - a listing, a share being resolved - and must not
 *  write. */
export async function findOrganizationDrive(orgId: string): Promise<OrganizationDrive | null> {
    const row = await prisma.storageConnection.findFirst({
        where: { id: organizationDriveId(orgId), orgId, kind: PERSONAL_KIND },
        select: { id: true, name: true, config: true }
    });
    return row ? driveOf(row) : null;
}

/** Which organization a connection belongs to, or null when it belongs to
 *  nobody's organization - which is every personal drive and every storage
 *  somebody connected. */
export async function organizationDriveOrg(connectionId: string): Promise<string | null> {
    const row = await prisma.storageConnection.findUnique({
        where: { id: connectionId },
        select: { kind: true, orgId: true }
    });
    return row && row.kind === PERSONAL_KIND ? row.orgId : null;
}

/** A connected driver onto this organization's drive, making the drive if
 *  needed. */
export async function organizationDriveDriver(orgId: string): Promise<StorageDriver> {
    const drive = await ensureOrganizationDrive(orgId);
    return getDriverForConnection(drive.id);
}

export interface OrganizationDriveSettings {
    /** What is stored: a connection id, `local`, or `auto`. */
    readonly choice: string;
    /** What that currently resolves to for a drive made now. */
    readonly resolved: UploadTarget;
    /** The storages an administrator can pick from. */
    readonly options: TargetOption[];
    /** How many already exist, and how they are spread over storages - because
     *  changing this setting moves nothing that is already somewhere. */
    readonly existing: ReadonlyArray<{ targetId: string; count: number }>;
}

/** What the uploads screen shows and edits for organization drives. */
export async function organizationDriveSettings(): Promise<OrganizationDriveSettings> {
    const [choice, resolved, options, drives] = await Promise.all([
        getSetting(ORGANIZATION_TARGET_KEY),
        resolveStorageTarget(ORGANIZATION_TARGET_KEY),
        storageTargetOptions(),
        prisma.storageConnection.findMany({
            where: { kind: PERSONAL_KIND, orgId: { not: null } },
            select: { config: true }
        })
    ]);

    const counts = new Map<string, number>();
    for (const row of drives) {
        const drive = driveOf({ id: "", name: "", config: row.config });
        if (drive) counts.set(drive.targetId, (counts.get(drive.targetId) ?? 0) + 1);
    }
    return {
        choice: choice ?? AUTOMATIC_TARGET,
        resolved,
        options,
        existing: [...counts].map(([targetId, count]) => ({ targetId, count }))
    };
}

/**
 * Take a company's files off the disk, before the row that says where they are
 * goes with the organization.
 *
 * The same rule as an account's own drive, and it is here for the same reason: a
 * cascade takes rows, not bytes, so without this a deleted organization's whole
 * shelf stays on the NAS with nothing left anywhere that knows whose it was or
 * that it is there at all.
 *
 * Answers what it could not remove rather than throwing. A storage that is away
 * must not be able to block a deletion somebody asked for and confirmed - the
 * organization still goes, and what was left behind is named in the audit entry
 * so an operator can take it out by hand.
 */
export async function discardOrganizationDrive(orgId: string): Promise<string | null> {
    const drive = await findOrganizationDrive(orgId);
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
        // a company's documents on the disk while reporting that nothing was
        // left.
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

/** Choose where the organization drives made from now on are kept. Moves
 *  nothing: a shelf records where its files actually are when it is made. */
export async function setOrganizationDriveTarget(target: string): Promise<void> {
    await setSetting(ORGANIZATION_TARGET_KEY, target);
}
