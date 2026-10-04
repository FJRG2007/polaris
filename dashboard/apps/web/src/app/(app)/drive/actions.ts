"use server";

/**
 * Drive server actions. Each one re-resolves the session and validates its input
 * server-side before touching storage, so the client can never drive an
 * operation it is not entitled to or with a path it has not been given. Metadata
 * mutations (folders, delete, rename) go here; the byte-streaming upload and
 * download paths are Route Handlers instead, because Server Actions buffer.
 */

import { AddressRefused } from "@/lib/storage-whereabouts/follow";
import { revalidatePath } from "next/cache";
import { getTranslations } from "@/lib/i18n/request";
import { recordAudit } from "@/lib/audit-service";
import { fetchUnasMetrics } from "@/lib/unifi-unas";
import { listLocks } from "@/lib/access-lock-service";
import { listConnections } from "@/lib/connections/store";
import { requirePermission, requireUser } from "@/lib/session";
import { invalidateFolderSizes } from "@/lib/drive-folder-size";
import { detectHost, type NasDetection } from "@/lib/nas-detect";
import { deletableChildren, deleteDriveEntry } from "@/lib/drive-delete";
import { writeArchiveToDriver, zipSourcesFor } from "@/lib/drive-archive";
import { createScheduledDeletion } from "@/lib/scheduled-deletion-service";
import type { ClashView } from "@/lib/drive/conflict-types";
import { assertMayReplace, clashView } from "@/lib/drive/clash-view";
import {
    claimFileName,
    claimFolderName,
    conflictModeSchema,
    moveToName,
    NameConflictError,
    replaceWith,
    stagingPath,
    type ConflictMode
} from "@/lib/drive/name-conflicts";
import {
    deleteTrashForever,
    emptyTrash,
    hasTrash,
    moveToTrash,
    restoreTrash,
    trashWithDriver
} from "@/lib/trash-service";
import {
    AlreadyGoingError,
    cancelDriveJob,
    pathsInFlight,
    DRIVE_JOB_MAX_PATHS,
    listDriveJobs,
    startDriveJob,
    type DriveJobView
} from "@/lib/drive-jobs";
import {
    authorizeDrive,
    authorizeDrivePaths,
    requireDriveDriver,
    DriveAccessError,
    DriveLockedError
} from "@/lib/drive-authz";
import {
    archiveFormatOf,
    extractArchiveTo,
    listArchiveEntries,
    type ArchiveEntry
} from "@/lib/drive-archive-read";
import {
    createConnection,
    discoverUnasShares,
    getDriver,
    setUnasSmbShare,
    updateConnection
} from "@/lib/storage-service";
import {
    moveItemMeta,
    recordItemCreator,
    setItemFavorite,
    setItemHidden,
    setItemIcon,
    setItemNote
} from "@/lib/drive-meta-service";
import {
    getConnectionRemovalPlan,
    removeConnection,
    type ConnectionRemovalMode,
    type ConnectionRemovalPlan,
    type RemoveConnectionResult
} from "@/lib/connection-removal-service";
import {
    baseName,
    createConnectionSchema,
    findConnectionProvider,
    normalizeRelPath,
    parentPath,
    removeConnectionSchema,
    storageConfigSchema,
    storageCredentialsSchema
} from "@polaris/core";

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
    if (!input.host?.trim())
        return { ok: false, error: (await getTranslations("drive"))("errors.consoleHost") };
    if (!input.username?.trim())
        return { ok: false, error: (await getTranslations("drive"))("errors.consoleUser") };
    if (!input.password)
        return { ok: false, error: (await getTranslations("drive"))("errors.consolePassword") };
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
        const message =
            caught instanceof Error ? caught.message : "Could not reach the UNAS console";
        return { ok: false, error: message };
    }
}

export async function detectNasAction(host: string): Promise<NasDetection | { error: string }> {
    await requirePermission("connections.manage");
    if (!host.trim()) return { error: (await getTranslations("drive"))("errors.detectHost") };
    try {
        return await detectHost(host);
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? caught.message
                    : (await getTranslations("drive"))("errors.detectFailed")
        };
    }
}

/** One account somebody has linked, as the connection form needs to offer it. */
export interface LinkedAccountOption {
    readonly accountId: string;
    readonly label: string;
}

/**
 * The caller's own linked accounts of one service, for the drives reached
 * through one.
 *
 * Scoped to the session rather than taking a user id: whose accounts these are
 * is never something the client gets to say. It returns the provider's account
 * id and a label and nothing else - no tokens, no scopes, nothing that would be
 * worth reading if this were ever called by something that should not.
 */
export async function linkedAccountsAction(provider: string): Promise<LinkedAccountOption[]> {
    const user = await requirePermission("connections.manage");
    if (!findConnectionProvider(provider)) return [];
    const rows = await listConnections(user.id, provider);
    return rows.map((row) => ({ accountId: row.accountId, label: row.label }));
}

export async function createConnectionAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("connections.manage");
    const parsed = createConnectionSchema.safeParse(input);
    if (!parsed.success)
        return {
            error:
                parsed.error.issues[0]?.message ??
                (await getTranslations("drive"))("errors.invalidConnection")
        };
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
    if (!name) return { error: (await getTranslations("drive"))("errors.connectionName") };

    const config = storageConfigSchema.safeParse(input.config);
    if (!config.success)
        return {
            error:
                config.error.issues[0]?.message ??
                (await getTranslations("drive"))("errors.invalidSettings")
        };

    // Only validate/replace credentials when the form actually supplied some; a
    // payload of just { kind } means "keep the existing secret".
    const rawCreds = input.credentials as Record<string, unknown> | undefined;
    const hasSecret = rawCreds ? Object.keys(rawCreds).some((key) => key !== "kind") : false;
    let credentials;
    if (hasSecret) {
        const parsed = storageCredentialsSchema.safeParse(rawCreds);
        if (!parsed.success)
            return {
                error:
                    parsed.error.issues[0]?.message ??
                    (await getTranslations("drive"))("errors.invalidCredentials")
            };
        credentials = parsed.data;
    }

    try {
        await updateConnection(user.id, connectionId, { name, config: config.data, credentials });
    } catch (caught) {
        // The device at the new address is not the one this storage's password
        // belongs to: said in the reader's words, with who answered instead.
        if (caught instanceof AddressRefused) {
            const t = await getTranslations("drive");
            return {
                error:
                    caught.check === "different"
                        ? t("errors.addressDifferent", {
                              address: caught.address,
                              device: caught.label ?? caught.address
                          })
                        : t("errors.addressSilent", { address: caught.address })
            };
        }
        return {
            error:
                caught instanceof Error
                    ? caught.message
                    : (await getTranslations("drive"))("errors.updateFailed")
        };
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
        return {
            error:
                caught instanceof Error
                    ? caught.message
                    : (await getTranslations("drive"))("errors.smbUnreachable")
        };
    }
}

/** Save the SMB share for a UNAS connection so its Files tab can browse over SMB. */
export async function setUnasShareAction(
    connectionId: string,
    share: string
): Promise<{ error?: string }> {
    const user = await requirePermission("connections.manage");
    if (!share.trim()) return { error: (await getTranslations("drive"))("errors.smbShare") };
    try {
        await setUnasSmbShare(user.id, connectionId, share);
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? caught.message
                    : (await getTranslations("drive"))("errors.smbSaveFailed")
        };
    }
    revalidatePath("/drive");
    return {};
}

/** What removing this connection would take with it, for the confirmation dialog. */
export async function connectionRemovalPlanAction(
    connectionId: string
): Promise<ConnectionRemovalPlan | null> {
    const user = await requirePermission("connections.manage");
    return getConnectionRemovalPlan(user.id, connectionId);
}

/**
 * Remove a connection the way the operator chose. Copying every file to another
 * device and redeploying what mounted it can take a long time, so this is one long
 * action the dialog waits on rather than a fire-and-forget.
 */
export async function removeConnectionAction(
    connectionId: string,
    input: { mode: ConnectionRemovalMode; destinationId?: string }
): Promise<RemoveConnectionResult> {
    const user = await requirePermission("connections.manage");
    const parsed = removeConnectionSchema.safeParse(input);
    if (!parsed.success)
        return {
            error:
                parsed.error.issues[0]?.message ??
                (await getTranslations("drive"))("errors.invalidRemoval")
        };

    const result = await removeConnection(user.id, connectionId, user.id, parsed.data);
    if (result.error) return result;

    await recordAudit({
        actorId: user.id,
        action: "connection.delete",
        targetType: "connection",
        targetId: connectionId,
        metadata: { mode: parsed.data.mode, movedTo: parsed.data.destinationId ?? null }
    });
    revalidatePath("/drive");
    return result;
}

/** Create a folder. Returns a structured error (never throws) so an unsupported
 *  source - a container filesystem cannot make directories - surfaces a clear
 *  message instead of a raw server exception. */
export async function mkdirAction(
    connectionId: string,
    path: string,
    name: string
): Promise<{ error?: string }> {
    const user = await requireUser();
    const target = normalizeRelPath(path ? `${path}/${name}` : name);
    let driver;
    try {
        // Cleared on the folder the new one actually lands in, not the one it was
        // asked from: a name carrying "../" or "a/b" is resolved above, and the
        // folder that resolves to is the one whose rules and lock apply.
        driver = await requireDriveDriver(user.id, connectionId, parentPath(target), "write");
    } catch (caught) {
        return {
            error: await driveErrorMessage(
                caught,
                (await getTranslations("drive"))("errors.createFolderDenied")
            )
        };
    }
    try {
        await driver.mkdir(target);
    } catch (caught) {
        return {
            error: await driveErrorMessage(
                caught,
                (await getTranslations("drive"))("errors.createFolderFailed")
            )
        };
    } finally {
        await driver.dispose();
    }
    await recordItemCreator(connectionId, target, user.id);
    await invalidateFolderSizes(connectionId, target);
    await recordAudit({
        actorId: user.id,
        action: "drive.mkdir",
        targetType: "connection",
        targetId: connectionId,
        metadata: { path: target }
    });
    revalidatePath("/drive");
    return {};
}

/** Create an empty file (any name/extension) in the given folder. Returns a
 *  structured error instead of throwing so a driver that refuses the write reports
 *  why rather than crashing the page. */
export async function createFileAction(
    connectionId: string,
    path: string,
    name: string
): Promise<{ error?: string }> {
    const user = await requireUser();
    const clean = name.trim();
    if (!clean) return { error: (await getTranslations("drive"))("errors.fileName") };
    const target = normalizeRelPath(path ? `${path}/${clean}` : clean);
    let driver;
    try {
        // The folder the file really lands in - see mkdirAction.
        driver = await requireDriveDriver(user.id, connectionId, parentPath(target), "write");
    } catch (caught) {
        return {
            error: await driveErrorMessage(
                caught,
                (await getTranslations("drive"))("errors.createFileDenied")
            )
        };
    }
    try {
        // A new file never empties one that is already there: the name is taken
        // only if it is free, in the same step that checks it.
        await claimFileName(driver, target, "fail");
    } catch (caught) {
        if (caught instanceof NameConflictError) {
            return {
                error: (await getTranslations("drive"))("errors.nameTaken", {
                    name: caught.clash.existingName
                })
            };
        }
        return {
            error: await driveErrorMessage(
                caught,
                (await getTranslations("drive"))("errors.createFileFailed")
            )
        };
    } finally {
        await driver.dispose();
    }
    await recordItemCreator(connectionId, target, user.id);
    await invalidateFolderSizes(connectionId, target);
    await recordAudit({
        actorId: user.id,
        action: "drive.create",
        targetType: "connection",
        targetId: connectionId,
        metadata: { path: target }
    });
    revalidatePath("/drive");
    return {};
}

export async function deleteEntryAction(
    connectionId: string,
    path: string
): Promise<{ error?: string }> {
    const user = await requireUser();
    try {
        const driver = await requireDriveDriver(user.id, connectionId, path, "delete");
        try {
            await deleteDriveEntry(driver, path);
        } finally {
            await driver.dispose();
        }
    } catch (caught) {
        return {
            error: await driveErrorMessage(
                caught,
                (await getTranslations("drive"))("errors.deleteFailed")
            )
        };
    }
    await invalidateFolderSizes(connectionId, normalizeRelPath(path));
    await recordAudit({
        actorId: user.id,
        action: "drive.delete",
        targetType: "connection",
        targetId: connectionId,
        metadata: { path }
    });
    revalidatePath("/drive");
    return {};
}

/**
 * Bundle the selected items into a single zip written to the NAS at
 * `<destFolder>/<name>.zip`. When a password is given the archive is AES-256
 * encrypted (the zip itself, not a link). Every source is authorized for download
 * and the destination folder for write; returns the created path so the caller
 * can, for example, generate a share link for it.
 */
export async function generateZipAction(
    connectionId: string,
    paths: string[],
    destFolder: string,
    name: string,
    password?: string
): Promise<{ path?: string; error?: string }> {
    const user = await requireUser();
    const sourcePaths = paths
        .map((entry) => normalizeRelPath(entry))
        .filter((entry) => entry.length > 0);
    if (sourcePaths.length === 0)
        return { error: (await getTranslations("drive"))("errors.nothingSelected") };

    try {
        for (const source of sourcePaths) {
            await authorizeDrive(user.id, connectionId, source, "download");
        }
        await authorizeDrive(user.id, connectionId, normalizeRelPath(destFolder), "write");
    } catch (caught) {
        if (caught instanceof DriveLockedError)
            return { error: (await getTranslations("drive"))("errors.selectionLocked") };
        if (caught instanceof DriveAccessError)
            return { error: (await getTranslations("drive"))("errors.cannotWrite") };
        throw caught;
    }

    const safeName = name.replace(/[/\\]/g, "_").trim() || "archive";
    const fileName = safeName.toLowerCase().endsWith(".zip") ? safeName : `${safeName}.zip`;
    const destPath = normalizeRelPath(destFolder ? `${destFolder}/${fileName}` : fileName);

    const driver = await getDriver(connectionId, user.id);
    let claimed = false;
    try {
        const parent = destPath.split("/").slice(0, -1).join("/");
        if (parent) await driver.mkdir(parent);
        // The archive never lands on a file that is already there: its name is
        // taken first, or refused, and given back if the archive fails.
        await claimFileName(driver, destPath, "fail");
        claimed = true;
        const lockedRoots = new Set(
            (await listLocks(connectionId)).map((lock) => lock.path).filter(Boolean)
        );
        await writeArchiveToDriver(
            driver,
            destPath,
            zipSourcesFor(driver, sourcePaths, lockedRoots),
            {
                password: password || undefined
            }
        );
    } catch (caught) {
        if (claimed) await driver.delete(destPath).catch(() => undefined);
        if (caught instanceof NameConflictError) {
            return {
                error: (await getTranslations("drive"))("errors.nameTaken", {
                    name: caught.clash.existingName
                })
            };
        }
        return {
            error:
                caught instanceof Error
                    ? caught.message
                    : (await getTranslations("drive"))("errors.archiveFailed")
        };
    } finally {
        await driver.dispose();
    }

    await invalidateFolderSizes(connectionId, destPath);
    await recordAudit({
        actorId: user.id,
        action: "drive.zip.create",
        targetType: "connection",
        targetId: connectionId,
        metadata: { path: destPath, encrypted: Boolean(password), count: sourcePaths.length }
    });
    revalidatePath("/drive");
    return { path: destPath };
}

/**
 * List an archive's contents (zip/rar) without extracting. A password is only
 * needed for an encrypted archive. Read-only; authorized for download.
 */
export async function previewArchiveAction(
    connectionId: string,
    archivePath: string,
    password?: string
): Promise<{ entries?: ArchiveEntry[]; error?: string }> {
    const user = await requireUser();
    const src = normalizeRelPath(archivePath);
    const format = archiveFormatOf(baseName(src));
    if (!format) return { error: (await getTranslations("drive"))("errors.archiveFormat") };
    try {
        await authorizeDrive(user.id, connectionId, src, "download");
    } catch (caught) {
        if (caught instanceof DriveLockedError)
            return { error: (await getTranslations("drive"))("errors.itemLocked") };
        if (caught instanceof DriveAccessError)
            return { error: (await getTranslations("drive"))("errors.notAllowed") };
        throw caught;
    }
    const driver = await getDriver(connectionId, user.id);
    try {
        return { entries: await listArchiveEntries(driver, src, format, password || undefined) };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? caught.message
                    : (await getTranslations("drive"))("errors.archiveRead")
        };
    } finally {
        await driver.dispose();
    }
}

/**
 * Extract an archive (zip/rar) into a folder on the NAS. Entry names are confined
 * under the destination (zip-slip) and total size/count are capped (bombs) inside
 * extractArchiveTo. Authorized for download on the archive and write on the dest.
 */
export async function extractArchiveAction(
    connectionId: string,
    archivePath: string,
    destFolder: string,
    password?: string
): Promise<{ count?: number; error?: string }> {
    const user = await requireUser();
    const src = normalizeRelPath(archivePath);
    const format = archiveFormatOf(baseName(src));
    if (!format) return { error: (await getTranslations("drive"))("errors.archiveFormat") };
    const dest = normalizeRelPath(destFolder);
    try {
        await authorizeDrive(user.id, connectionId, src, "download");
        await authorizeDrive(user.id, connectionId, dest, "write");
    } catch (caught) {
        if (caught instanceof DriveLockedError)
            return { error: (await getTranslations("drive"))("errors.pathLocked") };
        if (caught instanceof DriveAccessError)
            return { error: (await getTranslations("drive"))("errors.cannotWrite") };
        throw caught;
    }
    const driver = await getDriver(connectionId, user.id);
    let count = 0;
    try {
        count = await extractArchiveTo(driver, src, format, dest, password || undefined);
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? caught.message
                    : (await getTranslations("drive"))("errors.extractFailed")
        };
    } finally {
        await driver.dispose();
    }
    await invalidateFolderSizes(connectionId, dest);
    await recordAudit({
        actorId: user.id,
        action: "drive.archive.extract",
        targetType: "connection",
        targetId: connectionId,
        metadata: { path: src, dest, count }
    });
    revalidatePath("/drive");
    return { count };
}

/**
 * Empty a folder: remove everything inside it but keep the folder itself.
 * Authorized with "delete" on the folder (same right as deleting it). When
 * `permanent`, each direct child is deleted recursively for good; otherwise each
 * child is moved to the recycle bin, restorable from Trash.
 */
export async function emptyFolderAction(
    connectionId: string,
    path: string,
    permanent: boolean
): Promise<{ error?: string }> {
    const user = await requireUser();
    let children: string[];
    try {
        const driver = await requireDriveDriver(user.id, connectionId, path, "delete");
        try {
            const rel = normalizeRelPath(path);
            const { entries } = await driver.list(rel);
            // Emptying the root is emptying what the reader can see in it, which is
            // not what the driver lists: Polaris's own folder is in there and
            // belongs to nobody's clear-out, permanent or into the bin.
            children = deletableChildren(entries.map((child) => child.path));
            if (permanent) {
                for (const child of children) {
                    await driver.delete(child, { recursive: true });
                }
            }
        } finally {
            await driver.dispose();
        }
        // moveToTrash opens its own driver per item, so it runs after the listing
        // driver above is disposed.
        if (!permanent) {
            for (const child of children) {
                await moveToTrash(user.id, connectionId, child);
            }
        }
    } catch (caught) {
        return {
            error: await driveErrorMessage(
                caught,
                (await getTranslations("drive"))("errors.emptyFolderFailed")
            )
        };
    }
    await invalidateFolderSizes(connectionId, normalizeRelPath(path));
    await recordAudit({
        actorId: user.id,
        action: "drive.empty",
        targetType: "connection",
        targetId: connectionId,
        metadata: { path, permanent }
    });
    revalidatePath("/drive");
    if (!permanent) revalidatePath("/drive/trash");
    return {};
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
        return {
            error: await driveErrorMessage(
                caught,
                (await getTranslations("drive"))("errors.deleteDenied")
            )
        };
    }
    const when = new Date(deleteAt);
    if (Number.isNaN(when.getTime()))
        return { error: (await getTranslations("drive"))("errors.badDate") };
    if (when.getTime() <= Date.now())
        return { error: (await getTranslations("drive"))("errors.pastDate") };

    await createScheduledDeletion({
        ownerId: user.id,
        connectionId,
        path: normalizeRelPath(path),
        permanent,
        deleteAt: when
    });
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

/**
 * Move a selection to the bin, or delete it, as one job.
 *
 * The screen used to call the single-item action once per path. Every one of
 * those opened a connection to the storage and closed it again, so clearing a
 * folder of seven thousand files was seven thousand handshakes at a NAS, the
 * explorer was unusable while it ran, and closing the tab abandoned it halfway.
 *
 * This hands the whole list to a job that works it in batches over one open
 * connection, and answers with the job so the panel can draw a bar. Everything
 * is authorized here, before the job exists: the worker runs with nobody
 * watching, so it must never be the thing that decides whether this was allowed.
 */
export async function startDriveJobAction(
    connectionId: string,
    kind: "trash" | "delete",
    paths: string[]
): Promise<{ job?: DriveJobView; error?: string }> {
    const user = await requireUser();
    if (paths.length === 0)
        return { error: (await getTranslations("drive"))("errors.nothingWasSelected") };
    if (paths.length > DRIVE_JOB_MAX_PATHS) {
        return { error: (await getTranslations("drive"))("errors.tooManyForJob") };
    }

    try {
        // Every path, not a sample of them: a list somebody may not have read to
        // the end has its one untouchable file in the middle. In one call rather
        // than one per path, so the reader and the locks are resolved once - the
        // per-path version left this button sitting for a minute on a big
        // selection, before a single file had moved.
        await authorizeDrivePaths(user.id, connectionId, paths, "delete");
    } catch (caught) {
        return {
            error: await driveErrorMessage(
                caught,
                (await getTranslations("drive"))("errors.removeFailed")
            )
        };
    }

    try {
        const job = await startDriveJob({
            ownerId: user.id,
            connectionId,
            kind,
            label: (await getTranslations("drive"))(
                kind === "trash" ? "errors.jobTrash" : "errors.jobDelete",
                {
                    count: paths.length
                }
            ),
            paths
        });
        await recordAudit({
            actorId: user.id,
            action: kind === "trash" ? "drive.trash" : "drive.delete",
            targetType: "connection",
            targetId: connectionId,
            metadata: { paths: paths.length }
        });
        return { job };
    } catch (caught) {
        // Said plainly rather than as a failure: somebody pressing delete on
        // files already on their way out has done nothing wrong, and the
        // sentence has to say that is what happened.
        if (caught instanceof AlreadyGoingError) return { error: caught.message };
        return {
            error: await driveErrorMessage(
                caught,
                (await getTranslations("drive"))("errors.startFailed")
            )
        };
    }
}

/**
 * What is running, for the panel, and what is on its way out of the folder being
 * looked at.
 *
 * Polled while a job is going, so both halves are one indexed read each. The
 * second half is what stops a file being deleted twice: everything a job has not
 * reached yet is still in the listing, so a reload shows it again and it can be
 * selected again - and the second deletion then races the first, loses, and
 * reports a failure nobody caused.
 *
 * Narrowed to the folder on screen rather than sent whole. A job may carry fifty
 * thousand paths; what this screen can draw is the handful of them that are in
 * front of somebody.
 */
export async function driveJobsAction(
    connectionId?: string,
    folder?: string
): Promise<{ jobs: DriveJobView[]; going: string[] }> {
    const user = await requireUser();
    const jobs = await listDriveJobs(user.id);
    if (!connectionId) return { jobs, going: [] };

    // Everybody's jobs on this connection, not only this account's: two people
    // looking at the same shared folder are two people who can start the same
    // deletion, and the one who did not start it is the one who needs telling.
    // Nothing about the source is disclosed by it - these are paths they are
    // already looking at.
    const here = normalizeRelPath(folder ?? "");
    const going = [...(await pathsInFlight(connectionId))].filter((path) => {
        const parent = path.slice(0, Math.max(0, path.lastIndexOf("/")));
        return parent === here;
    });
    return { jobs, going };
}

/** Stop one. What has already moved stays moved - this is "stop", not "undo". */
export async function cancelDriveJobAction(id: string): Promise<{ error?: string }> {
    const user = await requireUser();
    await cancelDriveJob(user.id, id);
    return {};
}

/** Move an item to the recycle bin (the default "delete" from the browser). */
export async function moveToTrashAction(
    connectionId: string,
    path: string
): Promise<{ error?: string }> {
    const user = await requireUser();
    try {
        await authorizeDrive(user.id, connectionId, path, "delete");
        await moveToTrash(user.id, connectionId, path);
    } catch (caught) {
        return {
            error: await driveErrorMessage(
                caught,
                (await getTranslations("drive"))("errors.trashFailed")
            )
        };
    }
    await recordAudit({
        actorId: user.id,
        action: "drive.trash",
        targetType: "connection",
        targetId: connectionId,
        metadata: { path }
    });
    revalidatePath("/drive");
    revalidatePath("/drive/trash");
    return {};
}

/** Restore a trashed item to its original location. */
export async function restoreTrashAction(id: string): Promise<{ error?: string }> {
    const user = await requirePermission("drive.write");
    try {
        await restoreTrash(user.id, id);
    } catch (caught) {
        return {
            error: await driveErrorMessage(
                caught,
                (await getTranslations("drive"))("errors.restoreFailed")
            )
        };
    }
    revalidatePath("/drive");
    revalidatePath("/drive/trash");
    return {};
}

/** Permanently delete a single trashed item. */
export async function deleteTrashForeverAction(id: string): Promise<{ error?: string }> {
    const user = await requirePermission("drive.delete");
    try {
        await deleteTrashForever(user.id, id);
    } catch (caught) {
        return {
            error: await driveErrorMessage(
                caught,
                (await getTranslations("drive"))("errors.deleteFailed")
            )
        };
    }
    revalidatePath("/drive/trash");
    return {};
}

/** Permanently empty the recycle bin. */
export async function emptyTrashAction(): Promise<{ error?: string }> {
    const user = await requirePermission("drive.delete");
    try {
        await emptyTrash(user.id);
    } catch (caught) {
        return {
            error: await driveErrorMessage(
                caught,
                (await getTranslations("drive"))("errors.emptyBinFailed")
            )
        };
    }
    revalidatePath("/drive/trash");
    return {};
}

/** Human message for a Drive authorization/lock failure, else a fallback. */
async function driveErrorMessage(caught: unknown, fallback: string): Promise<string> {
    const t = await getTranslations("drive");
    if (caught instanceof DriveLockedError) return t("errors.locationLocked");
    if (caught instanceof DriveAccessError) return t("errors.locationDenied");
    return caught instanceof Error && caught.message ? caught.message : fallback;
}

/**
 * Move or rename an item. Returns a structured error instead of throwing so the
 * browser can surface why a move/paste failed (permission, lock, driver error)
 * rather than silently doing nothing.
 */
export async function renameAction(
    connectionId: string,
    from: string,
    to: string
): Promise<{ error?: string }> {
    const user = await requireUser();
    const normalizedFrom = normalizeRelPath(from);
    const normalizedTo = normalizeRelPath(to);
    let driver;
    try {
        // A rename that lands in another folder is a move, and takes the right to
        // write there - the same check a move into a folder makes.
        const destination = parentPath(normalizedTo);
        if (destination !== parentPath(normalizedFrom)) {
            await authorizeDrive(user.id, connectionId, destination, "write");
        }
        driver = await requireDriveDriver(user.id, connectionId, from, "rename");
    } catch (caught) {
        return {
            error: await driveErrorMessage(
                caught,
                (await getTranslations("drive"))("errors.renameDenied")
            )
        };
    }
    try {
        // Moving an item onto its own path is a no-op, not an error.
        if (normalizedFrom === normalizedTo) return {};
        // Refuse to move a folder into itself or one of its own descendants: the
        // driver would bury the folder inside its own subtree (or loop).
        if (normalizedTo.startsWith(`${normalizedFrom}/`)) {
            return { error: (await getTranslations("drive"))("errors.moveIntoSelf") };
        }
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
            return {
                error: (await getTranslations("drive"))("errors.nameTaken", {
                    name: baseName(normalizedTo)
                })
            };
        }
        await driver.move(normalizedFrom, normalizedTo);
    } catch (caught) {
        return {
            error: await driveErrorMessage(
                caught,
                (await getTranslations("drive"))("errors.moveFailed")
            )
        };
    } finally {
        await driver.dispose();
    }
    // Keep any custom icon / hidden flag attached to the item after it moves.
    await moveItemMeta(connectionId, normalizedFrom, normalizedTo);
    // Both ends change weight: the folder it left and the one it landed in.
    await invalidateFolderSizes(connectionId, normalizedFrom);
    await invalidateFolderSizes(connectionId, normalizedTo);
    await recordAudit({
        actorId: user.id,
        action: "drive.move",
        targetType: "connection",
        targetId: connectionId,
        metadata: { from, to }
    });
    revalidatePath("/drive");
    return {};
}

/** Hide or unhide an item in the browser (presentation only; the file is untouched). */
export async function setItemHiddenAction(
    connectionId: string,
    path: string,
    hidden: boolean
): Promise<void> {
    const user = await requirePermission("drive.write");
    await setItemHidden(user.id, connectionId, normalizeRelPath(path), hidden);
    revalidatePath("/drive");
}

/** Star or unstar an item (mark it a favorite). Presentation only. */
export async function setItemFavoriteAction(
    connectionId: string,
    path: string,
    favorite: boolean
): Promise<void> {
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
export async function setItemNoteAction(
    connectionId: string,
    path: string,
    note: string | null
): Promise<void> {
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

/**
 * The clash a move or copy ran into, for the screen to ask about again. A
 * folder moved or copied onto a folder keeps both - merging is an upload's
 * choice only.
 */
async function transferClash(
    userId: string,
    connectionId: string,
    driver: Driver,
    source: string,
    destParent: string,
    conflict: NameConflictError
): Promise<ClashView> {
    const kind = (await driver.stat(source).catch(() => null))?.kind === "dir" ? "dir" : "file";
    return clashView(userId, connectionId, destParent, conflict.clash, kind, false);
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
 * Move an item into a destination folder within the same connection - what a
 * paste, a drag onto a folder and the move dialog all do. Unlike a rename the
 * name is incidental, so a name already taken at the destination gets the same
 * " copy" suffix a copy would get, instead of refusing the move and leaving the
 * item behind. Both ends are authorized: the item leaves one folder and is
 * written into another.
 *
 * `onConflict` is the person's answer once Drive has asked them about a name
 * already taken there: `fail` (it was free when they looked - if it is not any
 * more, the clash comes back to ask about again), `keepBoth` ("name (1)") or
 * `replace` (a file only: the one there goes to the bin). Left out, the old
 * " copy" suffix applies, for callers that never ask.
 */
export async function moveIntoAction(
    connectionId: string,
    from: string,
    destFolder: string,
    onConflict?: ConflictMode
): Promise<{ error?: string; conflict?: ClashView }> {
    const user = await requireUser();
    const mode = conflictModeSchema.optional().safeParse(onConflict);
    if (!mode.success) return { error: (await getTranslations("drive"))("errors.moveFailed") };
    const source = normalizeRelPath(from);
    const destParent = normalizeRelPath(destFolder);
    if (destParent === source || destParent.startsWith(`${source}/`)) {
        return { error: (await getTranslations("drive"))("errors.moveIntoSelf") };
    }
    let driver;
    try {
        await authorizeDrive(user.id, connectionId, destFolder, "write");
        driver = await requireDriveDriver(user.id, connectionId, from, "rename");
    } catch (caught) {
        return {
            error: await driveErrorMessage(
                caught,
                (await getTranslations("drive"))("errors.moveDenied")
            )
        };
    }
    const base = baseName(source);
    let destination = normalizeRelPath(destParent ? `${destParent}/${base}` : base);
    try {
        // Already where it was asked to go: nothing to do, and a free name would
        // otherwise turn a no-op into a pointless " copy".
        if (destination === source) return {};
        if (mode.data === "replace") {
            await replaceWith(driver, source, destination, {
                guard: (clash) => assertMayReplace(user.id, connectionId, clash),
                trash: hasTrash(connectionId)
                    ? (existing) => trashWithDriver(driver, user.id, connectionId, existing)
                    : null
            });
        } else if (mode.data) {
            destination = await moveToName(driver, source, destination, mode.data);
        } else {
            destination = await freeName(driver, destination);
            await driver.move(source, destination);
        }
    } catch (caught) {
        if (caught instanceof NameConflictError) {
            return {
                conflict: await transferClash(
                    user.id,
                    connectionId,
                    driver,
                    source,
                    destParent,
                    caught
                )
            };
        }
        return {
            error: await driveErrorMessage(
                caught,
                (await getTranslations("drive"))("errors.moveFailed")
            )
        };
    } finally {
        await driver.dispose();
    }
    // Keep any custom icon / hidden flag attached to the item after it moves.
    await moveItemMeta(connectionId, source, destination);
    // Both ends change weight: the folder it left and the one it landed in.
    await invalidateFolderSizes(connectionId, source);
    await invalidateFolderSizes(connectionId, destination);
    await recordAudit({
        actorId: user.id,
        action: "drive.move",
        targetType: "connection",
        targetId: connectionId,
        metadata: { from: source, to: destination }
    });
    revalidatePath("/drive");
    return {};
}

/**
 * Copy an item into a destination folder within the same connection. The driver
 * has a native move but no copy, so this streams file bytes and walks folders.
 * Collisions get a " copy" suffix so pasting into the source folder is safe -
 * unless `onConflict` carries the person's answer to a clash Drive asked them
 * about, which works as it does for `moveIntoAction`.
 */
export async function copyAction(
    connectionId: string,
    from: string,
    destFolder: string,
    onConflict?: ConflictMode
): Promise<{ error?: string; conflict?: ClashView }> {
    const user = await requireUser();
    const mode = conflictModeSchema.optional().safeParse(onConflict);
    if (!mode.success) return { error: (await getTranslations("drive"))("errors.copyFailed") };
    const source = normalizeRelPath(from);
    const base = baseName(source);
    // Refuse to copy a folder into itself or a descendant: copyRecursive would walk
    // into the copies it writes under the source and never terminate.
    const destParent = normalizeRelPath(destFolder);
    if (destParent === source || destParent.startsWith(`${source}/`)) {
        return { error: (await getTranslations("drive"))("errors.copyIntoSelf") };
    }
    // Copy reads the source and writes into the destination folder; both ends must
    // be authorized.
    let driver;
    try {
        await authorizeDrive(user.id, connectionId, destFolder, "write");
        driver = await requireDriveDriver(user.id, connectionId, from, "copy");
    } catch (caught) {
        return {
            error: await driveErrorMessage(
                caught,
                (await getTranslations("drive"))("errors.copyDenied")
            )
        };
    }
    let destination = normalizeRelPath(destFolder ? `${destFolder}/${base}` : base);
    try {
        if (mode.data === "replace") {
            // Copied to a hidden name first, so a copy that fails partway has
            // not already put the file it was replacing in the bin.
            const staged = stagingPath(destination);
            try {
                await copyRecursive(driver, source, staged);
                await replaceWith(driver, staged, destination, {
                    guard: (clash) => assertMayReplace(user.id, connectionId, clash),
                    trash: hasTrash(connectionId)
                        ? (existing) => trashWithDriver(driver, user.id, connectionId, existing)
                        : null
                });
            } catch (error) {
                await driver.delete(staged).catch(() => undefined);
                throw error;
            }
        } else if (mode.data) {
            // The name is taken before the copy starts, so nothing that arrives
            // meanwhile is copied over; a file copy that fails gives it back.
            const isDir = (await driver.stat(source)).kind === "dir";
            destination = isDir
                ? await claimFolderName(driver, destination, mode.data)
                : await claimFileName(driver, destination, mode.data);
            try {
                await copyRecursive(driver, source, destination);
            } catch (error) {
                if (!isDir) await driver.delete(destination).catch(() => undefined);
                throw error;
            }
        } else {
            destination = await freeName(driver, destination);
            await copyRecursive(driver, source, destination);
        }
    } catch (caught) {
        if (caught instanceof NameConflictError) {
            return {
                conflict: await transferClash(
                    user.id,
                    connectionId,
                    driver,
                    source,
                    destParent,
                    caught
                )
            };
        }
        return {
            error: await driveErrorMessage(
                caught,
                (await getTranslations("drive"))("errors.copyFailed")
            )
        };
    } finally {
        await driver.dispose();
    }
    await recordItemCreator(connectionId, destination, user.id);
    await invalidateFolderSizes(connectionId, destination);
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
