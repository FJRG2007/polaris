/**
 * Streaming download. Reads a file through the connection's driver and streams it
 * to the client without buffering, honoring Range requests (206) so large files
 * and media scrubbing work. Node runtime because Prisma and the drivers need it.
 */

import { baseName, normalizeRelPath } from "@polaris/core";
import { userHasPermission } from "@polaris/auth";
import { requireUser } from "@/lib/session";
import { getDriver } from "@/lib/storage-service";
import { recordAudit } from "@/lib/audit-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RANGE = /^bytes=(\d+)-(\d*)$/;

export async function GET(request: Request): Promise<Response> {
    const user = await requireUser();
    if (!(await userHasPermission(user.id, "drive.read"))) {
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

    const driver = await getDriver(connectionId, user.id);
    const stat = await driver.stat(path);
    if (stat.kind !== "file") return new Response("Not a file", { status: 400 });

    await recordAudit({
        actorId: user.id,
        action: "drive.download",
        targetType: "connection",
        targetId: connectionId,
        metadata: { path, size: stat.size.toString() }
    });

    const headers = new Headers({
        "content-type": stat.mime ?? "application/octet-stream",
        "accept-ranges": "bytes",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(baseName(path))}`
    });

    const rangeHeader = request.headers.get("range");
    const match = rangeHeader ? RANGE.exec(rangeHeader) : null;
    if (match && driver.capabilities.randomRead) {
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : Number(stat.size) - 1;
        const stream = await driver.readStream(path, { start, end });
        headers.set("content-range", `bytes ${start}-${end}/${stat.size}`);
        headers.set("content-length", String(end - start + 1));
        return new Response(stream, { status: 206, headers });
    }

    const stream = await driver.readStream(path);
    headers.set("content-length", stat.size.toString());
    return new Response(stream, { status: 200, headers });
}
