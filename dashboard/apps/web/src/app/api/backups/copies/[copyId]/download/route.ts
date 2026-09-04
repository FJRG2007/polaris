/**
 * Stream one copy back out, wherever it lives - the data dir, a bucket, a linked
 * Drive, or the game server's own disk.
 *
 * A Route Handler rather than a server action because actions buffer, and the
 * whole point of a backup is that it is too big to hold in memory. Admin-only: a
 * copy is a full snapshot of whatever it protects.
 *
 * Node runtime for the streams.
 */

import { openCopy } from "@/lib/backups/manage";
import { apiAdmin } from "@/lib/api-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    _request: Request,
    context: { params: Promise<{ copyId: string }> }
): Promise<Response> {
    const user = await apiAdmin();
    if (user instanceof Response) return user;
    const { copyId } = await context.params;

    let opened;
    try {
        opened = await openCopy(user.id, copyId);
    } catch (error) {
        return new Response(error instanceof Error ? error.message : "Not found", { status: 404 });
    }

    // The handle stays open for as long as the body is being read, and is closed
    // when the stream ends either way - a cancelled download must not leave an
    // SFTP session or an SMB share held open.
    const body = opened.stream.pipeThrough(
        new TransformStream({
            flush: async () => {
                await opened.dispose().catch(() => undefined);
            }
        })
    );

    return new Response(body, {
        headers: {
            "Content-Type": "application/octet-stream",
            ...(opened.sizeBytes > 0 ? { "Content-Length": String(opened.sizeBytes) } : {}),
            "Content-Disposition": `attachment; filename="${opened.fileName.replace(/"/g, "")}"`
        }
    });
}
