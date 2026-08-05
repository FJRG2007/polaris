/**
 * Streaming download. Reads a file through the connection's driver and streams it
 * to the client without buffering, honoring Range requests (206) so large files
 * and media scrubbing work. Node runtime because Prisma and the drivers need it.
 */

import { mimeForName } from "@/lib/mime";
import { recordAudit } from "@/lib/audit-service";
import { pipeThenDispose } from "@/lib/drive-stream";
import { requireUser, sessionCan } from "@/lib/session";
import { baseName, normalizeRelPath } from "@polaris/core";
import { requireDriveDriver, DriveAccessError, DriveLockedError } from "@/lib/drive-authz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RANGE = /^bytes=(\d+)-(\d*)$/;

export async function GET(request: Request): Promise<Response> {
    const user = await requireUser();
    if (!(await sessionCan(user, "drive.read"))) {
        return new Response("Forbidden", { status: 403 });
    }

    const url = new URL(request.url);
    const connectionId = url.searchParams.get("c");
    const rawPath = url.searchParams.get("p") ?? "";
    if (!connectionId) return new Response("Missing connection", { status: 400 });

    let path: string;
    try {
        path = normalizeRelPath(rawPath);
    } catch {
        return new Response("Invalid path", { status: 400 });
    }

    let driver;
    try {
        driver = await requireDriveDriver(user.id, connectionId, path, "download");
    } catch (caught) {
        if (caught instanceof DriveLockedError) return new Response("Locked", { status: 423 });
        if (caught instanceof DriveAccessError) return new Response("Forbidden", { status: 403 });
        throw caught;
    }
    // The driver holds a pooled session, so every exit from here has to give it
    // back: on a stream, when the last byte leaves (or the client walks away);
    // on anything else, now.
    let streaming = false;
    try {
        const stat = await driver.stat(path);
        if (stat.kind !== "file") return new Response("Not a file", { status: 400 });

        await recordAudit({
            actorId: user.id,
            action: "drive.download",
            targetType: "connection",
            targetId: connectionId,
            metadata: { path, size: stat.size.toString() }
        });

        // An inline request feeds an in-dashboard viewer (image/pdf/media); the default
        // is an attachment download. Both stream the same bytes and honor Range.
        const inline = url.searchParams.get("disposition") === "inline";
        const headers = new Headers({
            "content-type": stat.mime ?? mimeForName(baseName(path)) ?? "application/octet-stream",
            "accept-ranges": "bytes",
            "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(baseName(path))}`
        });

        const rangeHeader = request.headers.get("range");
        const match = rangeHeader ? RANGE.exec(rangeHeader) : null;
        if (match && driver.capabilities.randomRead) {
            const start = Number(match[1]);
            const end = match[2] ? Number(match[2]) : Number(stat.size) - 1;
            const stream = await driver.readStream(path, { start, end });
            headers.set("content-range", `bytes ${start}-${end}/${stat.size}`);
            headers.set("content-length", String(end - start + 1));
            streaming = true;
            return new Response(pipeThenDispose(stream, driver), { status: 206, headers });
        }

        const stream = await driver.readStream(path);
        headers.set("content-length", stat.size.toString());
        streaming = true;
        return new Response(pipeThenDispose(stream, driver), { status: 200, headers });
    } finally {
        if (!streaming) await driver.dispose();
    }
}
