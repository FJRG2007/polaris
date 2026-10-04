/**
 * Streaming upload. The request body is piped straight into the connection's
 * driver, so an arbitrarily large file never lands in memory. An optional offset
 * query resumes an interrupted upload on drivers that support random writes.
 * Node runtime; Server Actions are avoided here because they buffer the body.
 *
 * A name that is already taken is never written over unasked. `conflict` says
 * what the uploader chose for it:
 *
 * - `fail` (the default): the name must be free at the moment of writing, or the
 *   answer is a 409 carrying the clash, for the screen to ask about. This is
 *   also what catches the race - another upload taking the name after the
 *   screen checked it.
 * - `keepBoth`: the file is saved as the first free "name (n).ext".
 * - `replace`: the file takes the name and the one that held it goes to the bin
 *   (or, on a source with no bin, is gone). Needs write access to that file.
 * - `overwrite`: write straight onto the name - an editor saving the file it
 *   has open, which is not a clash.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { sessionCan } from "@/lib/session";
import { apiUser } from "@/lib/api-session";
import { recordAudit } from "@/lib/audit-service";
import { storageRefusal } from "@/lib/storage-refusal";
import type { StorageDriver } from "@polaris/storage";
import { getDriverForConnection } from "@/lib/storage-service";
import { recordItemCreator } from "@/lib/drive-meta-service";
import { invalidateFolderSizes } from "@/lib/drive-folder-size";
import { hasTrash, trashWithDriver } from "@/lib/trash-service";
import { baseName, normalizeRelPath, parentPath } from "@polaris/core";
import { assertMayReplace, clashView } from "@/lib/drive/clash-view";
import { isUnreachable, StorageRefused } from "@/lib/storage-target";
import type { NameConflictAnswer } from "@/lib/drive/conflict-types";
import { authorizeDrive, DriveAccessError, DriveLockedError } from "@/lib/drive-authz";
import {
    claimFileName,
    findClash,
    NameConflictError,
    replaceWith,
    stagingPath,
    type Clash
} from "@/lib/drive/name-conflicts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
    c: z.string().trim().min(1),
    p: z.string().default(""),
    name: z.string().min(1),
    offset: z.coerce.number().int().min(0).optional(),
    conflict: z.enum(["fail", "keepBoth", "replace", "overwrite"]).default("fail")
});

export async function PUT(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    if (!(await sessionCan(user, "drive.write"))) {
        return new Response("Forbidden", { status: 403 });
    }

    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
        c: url.searchParams.get("c") ?? undefined,
        p: url.searchParams.get("p") ?? undefined,
        name: url.searchParams.get("name") ?? undefined,
        offset: url.searchParams.get("offset") ?? undefined,
        conflict: url.searchParams.get("conflict") ?? undefined
    });
    if (!parsed.success) return new Response("Missing parameters", { status: 400 });
    const { c: connectionId, p: rawPath, name, offset, conflict } = parsed.data;
    if (!request.body) return new Response("Empty body", { status: 400 });

    let target: string;
    let base: string;
    try {
        target = normalizeRelPath(rawPath ? `${rawPath}/${name}` : name);
        base = normalizeRelPath(rawPath);
    } catch {
        return new Response("Invalid path", { status: 400 });
    }
    // Writing into an existing file - a resumed upload or an editor's save -
    // is changing that file, and takes the right to change it.
    const writesInPlace = conflict === "overwrite" || (offset ?? 0) > 0;

    try {
        // Authorize against the destination folder (the parent), where the write lands.
        // That is the folder the normalized target sits in, not the `p` the caller
        // named: a `name` carrying `../` or a nested path moves the write out of
        // `p`, past the access rules and locks that were checked there.
        await authorizeDrive(user.id, connectionId, parentPath(target), "write");
        if (writesInPlace) await authorizeDrive(user.id, connectionId, target, "write");
    } catch (caught) {
        if (caught instanceof DriveLockedError) return new Response("Locked", { status: 423 });
        if (caught instanceof DriveAccessError) return new Response("Forbidden", { status: 403 });
        throw caught;
    }
    let driver;
    try {
        driver = await getDriverForConnection(connectionId);
    } catch (caught) {
        // The location would not open - a NAS that is off is the usual one. Said
        // by its name rather than as the framework's bare 500, which is all the
        // uploader used to get.
        console.error("drive: upload could not open the location:", caught);
        return unreachable(connectionId, caught, user.isAdmin);
    }
    try {
        // A folder upload sends nested names (a/b/file.txt); make sure the parent
        // directories exist before writing. mkdir on an existing dir is ignored -
        // which is the "merge" a folder upload into a folder of the same name is.
        const segments = target.split("/");
        segments.pop();
        let dir = "";
        for (const segment of segments) {
            dir = dir ? `${dir}/${segment}` : segment;
            try {
                await driver.mkdir(dir);
            } catch {
                // Already exists (or the driver made it implicitly); keep going.
            }
        }
        const written = writesInPlace
            ? await driver.writeStream(target, request.body, { offset })
            : conflict === "replace"
              ? await replaceUpload(driver, user.id, connectionId, target, request.body)
              : await newUpload(driver, target, request.body, conflict);
        const landed = normalizeRelPath(written.path || target);
        await recordItemCreator(connectionId, landed, user.id);
        await invalidateFolderSizes(connectionId, landed);
        await recordAudit({
            actorId: user.id,
            action: "drive.upload",
            targetType: "connection",
            targetId: connectionId,
            metadata: { path: landed, size: written.size.toString(), conflict }
        });
        return Response.json({
            ok: true,
            path: landed,
            name: baseName(landed),
            size: written.size.toString()
        });
    } catch (error) {
        if (error instanceof NameConflictError) {
            return conflictAnswer(user.id, connectionId, base, error.clash);
        }
        if (error instanceof DriveLockedError) return new Response("Locked", { status: 423 });
        if (error instanceof DriveAccessError) return new Response("Forbidden", { status: 403 });
        if (isUnreachable(error)) {
            console.error("drive: upload stopped, the location went away:", error);
            return unreachable(connectionId, error, user.isAdmin);
        }
        return new Response(error instanceof Error ? error.message : "Upload failed", {
            status: 500
        });
    } finally {
        await driver.dispose();
    }
}

/**
 * A file under a name of its own: the one asked for (`fail`) or the next free
 * "(n)" (`keepBoth`). The name is taken before the bytes start, and given back
 * if they do not all arrive, so a half-written file never stands under it.
 */
async function newUpload(
    driver: StorageDriver,
    target: string,
    body: ReadableStream<Uint8Array>,
    mode: "fail" | "keepBoth"
): Promise<{ path: string; size: bigint }> {
    const claimed = await claimFileName(driver, target, mode);
    try {
        const stat = await driver.writeStream(claimed, body, {});
        return { path: claimed, size: stat.size };
    } catch (error) {
        await driver.delete(claimed).catch(() => undefined);
        throw error;
    }
}

/**
 * A file that takes the name from the one holding it. The bytes land on a
 * hidden name first, so a transfer that fails leaves the old file untouched;
 * only a complete one is swapped in, and the old one goes to the bin. Write
 * access to the file being replaced is checked before the transfer and again
 * at the swap, against whatever holds the name by then.
 */
async function replaceUpload(
    driver: StorageDriver,
    userId: string,
    connectionId: string,
    target: string,
    body: ReadableStream<Uint8Array>
): Promise<{ path: string; size: bigint }> {
    const clash = await findClash(driver, target);
    if (clash) await assertMayReplace(userId, connectionId, clash);
    const staged = stagingPath(target);
    let size: bigint;
    try {
        size = (await driver.writeStream(staged, body, {})).size;
        await replaceWith(driver, staged, target, {
            guard: (current) => assertMayReplace(userId, connectionId, current),
            trash: hasTrash(connectionId)
                ? (existingPath) => trashWithDriver(driver, userId, connectionId, existingPath)
                : null
        });
    } catch (error) {
        await driver.delete(staged).catch(() => undefined);
        throw error;
    }
    return { path: target, size };
}

/** The 409 the screen turns back into a question. */
async function conflictAnswer(
    userId: string,
    connectionId: string,
    base: string,
    clash: Clash
): Promise<Response> {
    const answer: NameConflictAnswer = {
        error: "name_conflict",
        clash: await clashView(userId, connectionId, base, clash, "file")
    };
    return Response.json(answer, { status: 409 });
}

/** A location that is not answering, by the name its owner gave it. */
async function unreachable(
    connectionId: string,
    error: unknown,
    isAdmin: boolean
): Promise<Response> {
    const named = await prisma.storageConnection
        .findUnique({ where: { id: connectionId }, select: { name: true } })
        .catch(() => null);
    const said = new StorageRefused(
        error instanceof Error ? error.message : String(error),
        named?.name ?? null,
        isUnreachable(error),
        { cause: error }
    );
    return new Response(await storageRefusal(said, isAdmin), {
        status: said.unreachable ? 503 : 502
    });
}
