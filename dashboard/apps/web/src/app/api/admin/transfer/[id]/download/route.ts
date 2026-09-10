/**
 * Download an instance export once it has been written, then forget it.
 *
 * A Route Handler because the file is as large as the instance, and a server
 * action would hold it in memory. Admin-only, and addressed by the random id the
 * export action handed back, so nothing else can be fetched through it. The file
 * is sealed under the passphrase it was written with; it is removed once it has
 * been read to the end.
 */

import { Readable } from "node:stream";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { apiAdmin } from "@/lib/api-session";
import { dropTransferFile, transferPath } from "@/lib/instance-transfer/files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    const user = await apiAdmin();
    if (user instanceof Response) return user;
    const { id } = await context.params;
    const path = transferPath(id);
    const info = path ? await stat(path).catch(() => null) : null;
    if (!path || !info) return new Response("That export has already been downloaded or has expired", { status: 404 });

    const body = (Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>).pipeThrough(
        new TransformStream({
            flush: async () => {
                await dropTransferFile(id);
            }
        })
    );
    const day = new Date().toISOString().slice(0, 10);
    return new Response(body, {
        headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(info.size),
            "Content-Disposition": `attachment; filename="polaris-${day}.polaris"`,
            "Cache-Control": "no-store"
        }
    });
}
