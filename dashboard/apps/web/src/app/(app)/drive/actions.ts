"use server";

/**
 * Drive server actions. Each one re-resolves the session and validates its input
 * server-side before touching storage, so the client can never drive an
 * operation it is not entitled to or with a path it has not been given. Metadata
 * mutations (folders, delete, rename) go here; the byte-streaming upload and
 * download paths are Route Handlers instead, because Server Actions buffer.
 */

import { revalidatePath } from "next/cache";
import {
    baseName,
    createConnectionSchema,
    normalizeRelPath,
    storageConfigSchema,
    storageCredentialsSchema
} from "@polaris/core";
import { requirePermission, requireUser } from "@/lib/session";
import { authorizeDrive, requireDriveDriver, DriveAccessError, DriveLockedError } from "@/lib/drive-authz";
import {
    createConnection,
    deleteConnection,
    discoverUnasShares,
    getDriver,
    setUnasSmbShare,
    updateConnection
} from "@/lib/storage-service";
import { detectHost, type NasDetection } from "@/lib/nas-detect";
import { fetchUnasMetrics } from "@/lib/unifi-unas";
import { moveItemMeta, recordItemCreator, setItemFavorite, setItemHidden, setItemIcon, setItemNote } from "@/lib/drive-meta-service";
import { deleteTrashForever, emptyTrash, moveToTrash, restoreTrash } from "@/lib/trash-service";
import { createScheduledDeletion } from "@/lib/scheduled-deletion-service";
import { recordAudit } from "@/lib/audit-service";

/** Result of a UNAS connection dry-run: what the console reported, or why not. */
export interface UnasTestResult {
    readonly ok: boolean;
    readonly device?: string;
    readonly firmware?: string;
    readonly pools?: number;
    readonly bays?: number;
    readonly error?: string;
}

/**
 * Dry-run a UniFi UNAS connection before it is saved: log in to the console and
 * read the metrics once, so the user gets immediate, specific feedback (wrong
 * host, bad credentials, SSO/2FA account) instead of a connection that silently
 * shows nothing later. Nothing is persisted; credentials stay server-side.
 */
export async function testUnasConnectionAction(input: {
    host: string;
    port?: number;
    username: string;
    password: string;
    secure?: boolean;
}): Promise<UnasTestResult> {
    await requirePermission("connections.manage");
    if (!input.host?.trim()) return { ok: false, error: "Enter the console host or IP" };
    if (!input.username?.trim()) return { ok: false, error: "Enter the console username" };
    if (!input.password) return { ok: false, error: "Enter the console password" };
    try {
        const metrics = await fetchUnasMetrics({
            host: input.host.trim(),
            port: input.port,
            username: input.username.trim(),
            password: input.password,
            secure: input.secure
        });
        return {
            ok: true,
            device: metrics.system.name,
            firmware: metrics.system.firmware || undefined,
            pools: metrics.pools.length,
            bays: metrics.slotsPopulated
        };
    } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Could not reach the UNAS console";
        return { ok: false, error: message };
    }
}

export async function detectNasAction(host: string): Promise<NasDetection | { error: string }> {
    await requirePermission("connections.manage");
    if (!host.trim()) return { error: "Enter an IP or hostname first" };
    try {
        return await detectHost(host);
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Detection failed" };
    }
}

export async function createConnectionAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("connections.manage");
    const parsed = createConnectionSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid connection" };
    const created = await createConnection(
        user.id,
        parsed.data.name,
        parsed.data.config.kind,
        parsed.data.config,
        parsed.data.credentials
    );
    await recordAudit({
        actorId: user.id,
        action: "connection.create",
        targetType: "connection",
        targetId: created.id,
        metadata: { name: parsed.data.name, kind: parsed.data.config.kind }
    });
    revalidatePath("/drive");
    return {};
}

/**
 * Update an existing connection. The name and non-secret config are always
 * applied; credentials are only changed when new secret material is provided
 * (an empty credentials payload keeps the stored password/key), so editing a
 * host or port never forces re-entering secrets.
 */
export async function updateConnectionAction(
    connectionId: string,
    input: { name?: unknown; config?: unknown; credentials?: unknown }
): Promise<{ error?: string }> {
    const user = await requirePermission("connections.manage");
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) return { error: "Enter a connection name" };

    const config = storageConfigSchema.safeParse(input.config);
    if (!config.success) return { error: config.error.issues[0]?.message ?? "Invalid connection settings" };

    // Only validate/replace credentials when the form actually supplied some; a
    // payload of just { kind } means "keep the existing secret".
    const rawCreds = input.credentials as Record<string, unknown> | undefined;
    const hasSecret = rawCreds ? Object.keys(rawCreds).some((key) => key !== "kind") : false;
    let credentials;
    if (hasSecret) {
        const parsed = storageCredentialsSchema.safeParse(rawCreds);
        if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid credentials" };
        credentials = parsed.data;
    }

    try {
        await updateConnection(user.id, connectionId, { name, config: config.data, credentials });
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not update the connection" };
    }
    await recordAudit({
        actorId: user.id,
        action: "connection.update",
        targetType: "connection",
        targetId: connectionId,
        metadata: { name, kind: config.data.kind }
    });
    revalidatePath("/drive");
    return {};
}

/** Auto-discover the SMB shares a UNAS exposes (reusing its stored account). */
export async function discoverUnasSharesAction(
    connectionId: string
): Promise<{ shares?: string[]; error?: string }> {
    const user = await requirePermission("connections.manage");
    try {
        return { shares: await discoverUnasShares(user.id, connectionId) };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not reach SMB on the device" };
    }
}

/** Save the SMB share for a UNAS connection so its Files tab can browse over SMB. */
export async function setUnasShareAction(connectionId: string, share: string): Promise<{ error?: string }> {
    const user = await requirePermission("connections.manage");
    if (!share.trim()) return { error: "Enter the SMB share name" };
    try {
        await setUnasSmbShare(user.id, connectionId, share);
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the share" };
    }
    revalidatePath("/drive");
    return {};
}

export async function deleteConnectionAction(connectionId: string): Promise<void> {
    const user = await requirePermission("connections.manage");
    await deleteConnection(user.id, connectionId);
    await recordAudit({ actorId: user.id, action: "connection.delete", targetType: "connection", targetId: connectionId });
    revalidatePath("/drive");
}

export async function mkdirAction(connectionId: string, path: string, name: string): Promise<void> {
    const user = await requireUser();
    const target = normalizeRelPath(path ? `${path}/${name}` : name);
    const driver = await requireDriveDriver(user.id, connectionId, path, "write");
    try {
        await driver.mkdir(target);
    } finally {
        await driver.dispose();
    }
    await recordItemCreator(connectionId, target, user.id);
    await recordAudit({ actorId: user.id, action: "drive.mkdir", targetType: "connection", targetId: connectionId, metadata: { path: target } });
    revalidatePath("/drive");
}

/** Create an empty file (any name/extension) in the given folder. */
export async function createFileAction(connectionId: string, path: string, name: string): Promise<void> {
    const user = await requireUser();
    const clean = name.trim();
    if (!clean) throw new Error("Enter a file name");
    const target = normalizeRelPath(path ? `${path}/${clean}` : clean);
    const driver = await requireDriveDriver(user.id, connectionId, path, "write");
    try {
        const empty = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.close();
            }
        });
        await driver.writeStream(target, empty, {});
    } finally {
        await driver.dispose();
    }
    await recordItemCreator(connectionId, target, user.id);
    await recordAudit({ actorId: user.id, action: "drive.create", targetType: "connection", targetId: connectionId, metadata: { path: target } });
    revalidatePath("/drive");
}

export async function deleteEntryAction(connectionId: string, path: string): Promise<void> {
    const user = await requireUser();
    const driver = await requireDriveDriver(user.id, connectionId, path, "delete");
    try {
        await driver.delete(normalizeRelPath(path), { recursive: true });
    } finally {
        await driver.dispose();
    }
    await recordAudit({ actorId: user.id, action: "drive.delete", targetType: "connection", targetId: connectionId, metadata: { path } });
    revalidatePath("/drive");
}

/**
 * Empty a folder: permanently delete everything inside it but keep the folder
 * itself. Authorized with "delete" on the folder (same right as deleting it),
 * then each direct child is removed recursively. This is a permanent delete, not
 * a move to Trash - matching deleteEntryAction.
 */
export async function emptyFolderAction(connectionId: string, path: string): Promise<void> {
    const user = await requireUser();
    const driver = await requireDriveDriver(user.id, connectionId, path, "delete");
    try {
        const rel = normalizeRelPath(path);
        const { entries } = await driver.list(rel);
        for (const child of entries) {
            await driver.delete(normalizeRelPath(child.path), { recursive: true });
        }
    } finally {
        await driver.dispose();
    }
    await recordAudit({ actorId: user.id, action: "drive.empty", targetType: "connection", targetId: connectionId, metadata: { path } });
    revalidatePath("/drive");
}

/**
 * Schedule an item's deletion for a future time. Owner/ACL-authorized like a real
 * delete; the sweep (lazy on browse, or the cron) carries it out later. `permanent`
 * chooses a real delete over the recycle bin.
 */
export async function scheduleDeleteAction(
    connectionId: string,
    path: string,
    deleteAt: string,
    permanent: boolean
): Promise<{ error?: string }> {
    const user = await requireUser();
    try {
        await authorizeDrive(user.id, connectionId, path, "delete");
    } catch (caught) {
        return { error: driveErrorMessage(caught, "You cannot delete this item.") };
    }
    const when = new Date(deleteAt);
    if (Number.isNaN(when.getTime())) return { error: "Pick a valid date and time." };
    if (when.getTime() <= Date.now()) return { error: "Pick a time in the future." };

    await createScheduledDeletion({ ownerId: user.id, connectionId, path: normalizeRelPath(path), permanent, deleteAt: when });
    await recordAudit({
        actorId: user.id,
        action: "drive.schedule_delete",
        targetType: "connection",
        targetId: connectionId,
        metadata: { path, deleteAt: when.toISOString(), permanent }
    });
    revalidatePath("/drive");
    return {};
}

/** Move an item to the recycle bin (the default "delete" from the browser). */
export async function moveToTrashAction(connectionId: string, path: string): Promise<void> {
    const user = await requireUser();
    await authorizeDrive(user.id, connectionId, path, "delete");
    await moveToTrash(user.id, connectionId, path);
    await recordAudit({ actorId: user.id, action: "drive.trash", targetType: "connection", targetId: connectionId, metadata: { path } });
    revalidatePath("/drive");
    revalidatePath("/trash");
}

/** Restore a trashed item to its original location. */
export async function restoreTrashAction(id: string): Promise<void> {
    const user = await requirePermission("drive.write");
    await restoreTrash(user.id, id);
    revalidatePath("/drive");
    revalidatePath("/trash");
}

/** Permanently delete a single trashed item. */
export async function deleteTrashForeverAction(id: string): Promise<void> {
    const user = await requirePermission("drive.delete");
    await deleteTrashForever(user.id, id);
    revalidatePath("/trash");
}

/** Permanently empty the recycle bin. */
export async function emptyTrashAction(): Promise<void> {
    const user = await requirePermission("drive.delete");
    await emptyTrash(user.id);
    revalidatePath("/trash");
}

/** Human message for a Drive authorization/lock failure, else a fallback. */
function driveErrorMessage(caught: unknown, fallback: string): string {
    if (caught instanceof DriveLockedError) return "That location is locked.";
    if (caught instanceof DriveAccessError) return "You do not have access to that location.";
    return caught instanceof Error && caught.message ? caught.message : fallback;
}

/**
 * Move or rename an item. Returns a structured error instead of throwing so the
 * browser can surface why a move/paste failed (permission, lock, driver error)
 * rather than silently doing nothing.
 */
export async function renameAction(connectionId: string, from: string, to: string): Promise<{ error?: string }> {
    const user = await requireUser();
    const normalizedFrom = normalizeRelPath(from);
    const normalizedTo = normalizeRelPath(to);
    let driver;
    try {
        driver = await requireDriveDriver(user.id, connectionId, from, "rename");
    } catch (caught) {
        return { error: driveErrorMessage(caught, "You cannot move or rename this item.") };
    }
    try {
        // Moving an item onto its own path is a no-op, not an error.
        if (normalizedFrom === normalizedTo) return {};
        // Refuse to move onto an existing item: a native rename would either fail
        // with an opaque driver error or clobber the target. Reporting the clash
        // is why a folder can look "stuck" - the destination name is already taken.
        let destinationTaken = false;
        try {
            await driver.stat(normalizedTo);
            destinationTaken = true;
        } catch {
            destinationTaken = false;
        }
        if (destinationTaken) {
            return { error: `An item named "${baseName(normalizedTo)}" already exists in that folder.` };
        }
        await driver.move(normalizedFrom, normalizedTo);
    } catch (caught) {
        return { error: driveErrorMessage(caught, "Could not move the item.") };
    } finally {
        await driver.dispose();
    }
    // Keep any custom icon / hidden flag attached to the item after it moves.
    await moveItemMeta(connectionId, normalizedFrom, normalizedTo);
    await recordAudit({ actorId: user.id, action: "drive.move", targetType: "connection", targetId: connectionId, metadata: { from, to } });
    revalidatePath("/drive");
    return {};
}

/** Hide or unhide an item in the browser (presentation only; the file is untouched). */
export async function setItemHiddenAction(connectionId: string, path: string, hidden: boolean): Promise<void> {
    const user = await requirePermission("drive.write");
    await setItemHidden(user.id, connectionId, normalizeRelPath(path), hidden);
    revalidatePath("/drive");
}

/** Star or unstar an item (mark it a favorite). Presentation only. */
export async function setItemFavoriteAction(connectionId: string, path: string, favorite: boolean): Promise<void> {
    const user = await requirePermission("drive.write");
    await setItemFavorite(user.id, connectionId, normalizeRelPath(path), favorite);
    revalidatePath("/drive");
}

/** Set or clear an item's custom icon and color. */
export async function setItemIconAction(
    connectionId: string,
    path: string,
    icon: string | null,
    iconColor: string | null
): Promise<void> {
    const user = await requirePermission("drive.write");
    await setItemIcon(user.id, connectionId, normalizeRelPath(path), icon, iconColor);
    revalidatePath("/drive");
}

/** Set or clear a free-text note on an item. */
export async function setItemNoteAction(connectionId: string, path: string, note: string | null): Promise<void> {
    const user = await requirePermission("drive.write");
    await setItemNote(user.id, connectionId, normalizeRelPath(path), note);
    revalidatePath("/drive");
}

type Driver = Awaited<ReturnType<typeof getDriver>>;

/** Whether a path exists (stat succeeds) on a driver. */
async function pathExists(driver: Driver, path: string): Promise<boolean> {
    try {
        await driver.stat(path);
        return true;
    } catch {
        return false;
    }
}

/** Insert a suffix before a file's extension (or at the end for a folder/name). */
function withSuffix(path: string, suffix: string): string {
    const slash = path.lastIndexOf("/");
    const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    const dot = name.lastIndexOf(".");
    if (dot > 0) return `${dir}${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
    return `${dir}${name}${suffix}`;
}

/** Find a non-colliding destination path, appending " copy" as needed. */
async function freeName(driver: Driver, to: string): Promise<string> {
    if (!(await pathExists(driver, to))) return to;
    for (let index = 1; index < 100; index++) {
        const candidate = withSuffix(to, index === 1 ? " copy" : ` copy ${index}`);
        if (!(await pathExists(driver, candidate))) return candidate;
    }
    return withSuffix(to, ` copy ${Date.now()}`);
}

/** Copy a file or a folder (recursively) from one path to another on a driver. */
async function copyRecursive(driver: Driver, from: string, to: string): Promise<void> {
    const stat = await driver.stat(from);
    if (stat.kind === "dir") {
        await driver.mkdir(to);
        const { entries } = await driver.list(from);
        for (const entry of entries) {
            await copyRecursive(driver, entry.path, `${to}/${entry.name}`);
        }
    } else {
        const stream = await driver.readStream(from);
        await driver.writeStream(to, stream, {});
    }
}

/**
 * Copy an item into a destination folder within the same connection. The driver
 * has a native move but no copy, so this streams file bytes and walks folders.
 * Collisions get a " copy" suffix so pasting into the source folder is safe.
 */
export async function copyAction(connectionId: string, from: string, destFolder: string): Promise<{ error?: string }> {
    const user = await requireUser();
    const source = normalizeRelPath(from);
    const base = baseName(source);
    // Copy reads the source and writes into the destination folder; both ends must
    // be authorized.
    let driver;
    try {
        await authorizeDrive(user.id, connectionId, destFolder, "write");
        driver = await requireDriveDriver(user.id, connectionId, from, "copy");
    } catch (caught) {
        return { error: driveErrorMessage(caught, "You cannot copy into that location.") };
    }
    let destination = "";
    try {
        destination = await freeName(driver, normalizeRelPath(destFolder ? `${destFolder}/${base}` : base));
        await copyRecursive(driver, source, destination);
    } catch (caught) {
        return { error: driveErrorMessage(caught, "Could not copy the item.") };
    } finally {
        await driver.dispose();
    }
    await recordItemCreator(connectionId, destination, user.id);
    await recordAudit({
        actorId: user.id,
        action: "drive.copy",
        targetType: "connection",
        targetId: connectionId,
        metadata: { from: source, to: destFolder }
    });
    revalidatePath("/drive");
    return {};
}
