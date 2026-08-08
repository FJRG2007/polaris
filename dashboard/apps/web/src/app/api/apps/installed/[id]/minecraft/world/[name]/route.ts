import { Readable } from "node:stream";
import { requirePermission } from "@/lib/session";
import { isGameServerApp } from "@/lib/apps/games-service";
import { getInstalledApp } from "@/lib/apps/install-service";
import { readContainerFile } from "@/lib/container-files-service";
import { backupPathInContainer } from "@/lib/apps/minecraft/world-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Download a world archive.
 *
 * The point of it: a backup lives beside the world it came from, on the same disk
 * the server runs on, so it survives a mistake and not the disk. This is the copy
 * that leaves the machine, and it is streamed straight out of the container
 * rather than staged anywhere - a world is gigabytes, and nothing here should
 * ever hold one in memory.
 */
export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string; name: string }> }
): Promise<Response> {
    const user = await requirePermission("games.manage");
    const { id, name } = await params;

    const install = await getInstalledApp(user.id, id);
    if (!install || !isGameServerApp(install.catalogId)) return new Response("Not found", { status: 404 });
    if (!install.applicationId) return new Response("This server has not been deployed yet", { status: 409 });

    let path: string;
    try {
        // Already decoded by the router; decoding it again would let a doubly
        // encoded separator through the name check as something else.
        path = backupPathInContainer(name);
    } catch {
        return new Response("Invalid backup", { status: 400 });
    }

    try {
        const stream = await readContainerFile(install.applicationId, user.id, path);
        return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
            headers: {
                "Content-Type": "application/gzip",
                // The archive is one server's world, so the name says which - the
                // stamp alone would be four downloads called the same thing.
                "Content-Disposition": `attachment; filename="${fileName(install.name, name)}"`
            }
        });
    } catch (caught) {
        return new Response(
            caught instanceof Error ? caught.message : "Could not read the backup",
            { status: 400 }
        );
    }
}

/** `<server>-<stamp>.tar.gz`, with anything a filename cannot carry taken out. */
function fileName(server: string, backup: string): string {
    const slug = server
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
    return slug ? `${slug}-${backup}` : backup;
}
