/**
 * Download a database backup file. Admin-only, since a backup is a full copy of
 * the deployment's data. The name is validated against path traversal by
 * backupPath before anything is read. Node runtime for filesystem streaming.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { requireAdmin } from "@/lib/session";
import { backupFilePath } from "@/lib/backup-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }): Promise<Response> {
    await requireAdmin();
    const { name } = await params;

    let path: string;
    try {
        path = await backupFilePath(name);
    } catch {
        return new Response("Invalid backup", { status: 400 });
    }

    let size: number;
    try {
        size = (await stat(path)).size;
    } catch {
        return new Response("Not found", { status: 404 });
    }

    const stream = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
    return new Response(stream, {
        headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(size),
            "Content-Disposition": `attachment; filename="${name}"`
        }
    });
}
