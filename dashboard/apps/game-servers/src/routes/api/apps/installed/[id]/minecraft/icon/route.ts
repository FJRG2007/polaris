import { prisma } from "@polaris/db";
import { gameWords } from "../../../../../../../screens/game-words";
import { NextResponse } from "next/server";
import { host } from "@polaris/app-host";
import { readServerIcon } from "../../../../../../../lib/minecraft/server-icon";

const { requireGameServer } = host.appsInstallAccess;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The icon this server is actually carrying.
 *
 * The panel used to show only the image somebody had just picked, held in the
 * browser - so a reload emptied the box and an operator who had set one had no
 * way to see it and reasonably concluded it had not saved. This reads the file
 * back out of the container, which is the only place it lives.
 *
 * 404 rather than an error for a server with no icon, a stopped container, or a
 * remote one: none of those is a failure worth a red panel, and the card says
 * what it can see either way.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    const { id } = await params;
    const { access } = await requireGameServer("games.read", id);
    const install = await prisma.installedApp.findFirst({
        where: { id, ownerId: access.ownerId, status: { not: "removed" } },
        select: { applicationId: true }
    });
    if (!install?.applicationId) return NextResponse.json({ error: (await gameWords("games"))("errors.noIcon") }, { status: 404 });
    const bytes = await readServerIcon(install.applicationId, access.ownerId);
    if (!bytes) return NextResponse.json({ error: (await gameWords("games"))("errors.noIcon") }, { status: 404 });
    return new Response(new Uint8Array(bytes), {
        headers: {
            "content-type": "image/png",
            // The panel busts this with the time the icon was set, so a new
            // one shows at once and an unchanged one is not re-read.
            "cache-control": "private, max-age=300"
        }
    });
}
