"use server";

/**
 * The question Drive asks before something lands in a folder: which of these
 * names are already taken there. Asked before an upload, a paste or a move, so
 * the person decides - replace, keep both, merge, skip - before anything is
 * written. The writes themselves check again; this is the asking half.
 */

import { z } from "zod";
import { requireUser } from "@/lib/session";
import { clashView } from "@/lib/drive/clash-view";
import { getTranslations } from "@/lib/i18n/request";
import { MAX_CLASH_ENTRIES, type ClashView } from "@/lib/drive/conflict-types";
import { getDriverForConnection } from "@/lib/storage-service";
import { baseName, normalizeRelPath, parentPath } from "@polaris/core";
import { claimFolderName, findClashes } from "@/lib/drive/name-conflicts";
import {
    authorizeDrive,
    DriveAccessError,
    DriveLockedError,
    drivePathFilter
} from "@/lib/drive-authz";

const clashQuerySchema = z.object({
    connectionId: z.string().trim().min(1).max(200),
    folder: z.string().max(4096),
    entries: z
        .array(
            z.object({
                path: z.string().trim().min(1).max(4096),
                kind: z.enum(["file", "dir"])
            })
        )
        .max(MAX_CLASH_ENTRIES),
    /** Whether a folder onto a folder may be merged (an upload) or not (a move, a copy). */
    merge: z.boolean().default(true)
});

/**
 * Which of `entries` (paths relative to `folder`) would land on a name already
 * taken. A nested path ("album/photo.jpg") is checked in its own folder, which
 * is how the files inside a folder being merged are asked about.
 */
export async function nameClashesAction(
    input: unknown
): Promise<{ clashes: ClashView[]; error?: undefined } | { error: string }> {
    const user = await requireUser();
    const t = await getTranslations("drive");
    const parsed = clashQuerySchema.safeParse(input);
    if (!parsed.success) return { error: t("conflicts.checkFailed") };
    const { connectionId, entries, merge } = parsed.data;
    let folder: string;
    let paths: { path: string; kind: "file" | "dir" }[];
    try {
        folder = normalizeRelPath(parsed.data.folder);
        paths = entries.map((entry) => ({
            path: normalizeRelPath(folder ? `${folder}/${entry.path}` : entry.path),
            kind: entry.kind
        }));
    } catch {
        return { error: t("conflicts.checkFailed") };
    }
    // Every arrival has to stay inside the folder it was sent to.
    if (paths.some(({ path }) => folder && !path.startsWith(`${folder}/`))) {
        return { error: t("conflicts.checkFailed") };
    }
    try {
        await authorizeDrive(user.id, connectionId, folder, "write");
    } catch (caught) {
        if (caught instanceof DriveLockedError) return { error: t("errors.locationLocked") };
        if (caught instanceof DriveAccessError) return { error: t("errors.cannotWrite") };
        throw caught;
    }
    // A folder inside this one that the person may not read is not listed for
    // them; the write into it is refused on its own terms.
    const readable = await drivePathFilter(user.id, connectionId, "read");
    const visible: typeof paths = [];
    for (const entry of paths) {
        if (await readable(parentPath(entry.path))) visible.push(entry);
    }
    const kinds = new Map(visible.map((entry) => [entry.path, entry.kind]));
    let driver;
    try {
        driver = await getDriverForConnection(connectionId);
    } catch (caught) {
        console.error("drive: clash check could not open the location:", caught);
        return { error: t("conflicts.checkFailed") };
    }
    try {
        const clashes = await findClashes(
            driver,
            visible.map((entry) => entry.path)
        );
        const views: ClashView[] = [];
        for (const clash of clashes) {
            views.push(
                await clashView(
                    user.id,
                    connectionId,
                    folder,
                    clash,
                    kinds.get(clash.path) ?? "file",
                    merge
                )
            );
        }
        return { clashes: views };
    } catch (caught) {
        console.error("drive: clash check failed:", caught);
        return { error: t("conflicts.checkFailed") };
    } finally {
        await driver.dispose();
    }
}

const reserveSchema = z.object({
    connectionId: z.string().trim().min(1).max(200),
    folder: z.string().max(4096),
    name: z.string().trim().min(1).max(255)
});

/**
 * "Keep both" for a folder being uploaded: make the folder under the first free
 * "name (n)" and return that name, so the upload's files go into it rather than
 * into the folder that was already there.
 */
export async function reserveFolderAction(
    input: unknown
): Promise<{ name: string; error?: undefined } | { error: string }> {
    const user = await requireUser();
    const t = await getTranslations("drive");
    const parsed = reserveSchema.safeParse(input);
    if (!parsed.success) return { error: t("errors.createFolderFailed") };
    let path: string;
    try {
        const folder = normalizeRelPath(parsed.data.folder);
        path = normalizeRelPath(folder ? `${folder}/${parsed.data.name}` : parsed.data.name);
        // A single name, landing in `folder` itself.
        if (parentPath(path) !== folder) return { error: t("errors.createFolderFailed") };
        await authorizeDrive(user.id, parsed.data.connectionId, folder, "write");
    } catch (caught) {
        if (caught instanceof DriveLockedError) return { error: t("errors.locationLocked") };
        if (caught instanceof DriveAccessError) return { error: t("errors.createFolderDenied") };
        return { error: t("errors.createFolderFailed") };
    }
    let driver;
    try {
        driver = await getDriverForConnection(parsed.data.connectionId);
    } catch {
        return { error: t("errors.createFolderFailed") };
    }
    try {
        return { name: baseName(await claimFolderName(driver, path, "keepBoth")) };
    } catch (caught) {
        console.error("drive: could not make the folder for keep both:", caught);
        return { error: t("errors.createFolderFailed") };
    } finally {
        await driver.dispose();
    }
}
