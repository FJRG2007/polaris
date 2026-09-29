import { prisma } from "@polaris/db";
import { gameOfServer } from "@polaris/core";
import { host } from "@polaris/app-host";
import { readServerIcon } from "../../../../../../../lib/minecraft/server-icon";

const { requireUser } = host.session;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A server's icon, for the "Playing on a server here" card beside somebody's
 * face.
 *
 * Any signed-in reader, not only the server's operators: the card is shown to
 * whoever may see that person's activity, and the icon is what the game itself
 * shows to anybody who lists the server. Nothing else about the server is said
 * here, and only a Minecraft server that still exists answers.
 *
 * A bare 404 for no icon, so the card draws the game's mark instead.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    await requireUser();
    const { id } = await params;
    const install = await prisma.installedApp
        .findFirst({
            where: { id, status: { not: "removed" } },
            select: { applicationId: true, ownerId: true, catalogId: true }
        })
        .catch(() => null);
    if (!install?.applicationId || gameOfServer(install.catalogId)?.id !== "minecraft") {
        return new Response(null, { status: 404 });
    }
    const bytes = await readServerIcon(install.applicationId, install.ownerId);
    if (!bytes) return new Response(null, { status: 404, headers: { "cache-control": "private, max-age=300" } });
    return new Response(new Uint8Array(bytes), {
        headers: { "content-type": "image/png", "cache-control": "private, max-age=300" }
    });
}
