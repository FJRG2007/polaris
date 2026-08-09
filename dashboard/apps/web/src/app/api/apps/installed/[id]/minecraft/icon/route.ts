import { prisma } from "@polaris/db";
import { NextResponse } from "next/server";
import { requireGameServer } from "@/lib/apps/install-access";
import { readContainerFile } from "@/lib/container-files-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Where the image writes the server's icon, and where the game reads it from. */
const ICON_PATH = "/data/server-icon.png";

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
    if (!install?.applicationId) return NextResponse.json({ error: "No icon" }, { status: 404 });
    try {
        const stream = await readContainerFile(install.applicationId, access.ownerId, ICON_PATH);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
        const bytes = Buffer.concat(chunks);
        // `cat` on a path that is not there exits non-zero and prints to stderr,
        // which reaches here as an empty body rather than as a throw.
        if (bytes.length === 0 || !isPng(bytes)) return NextResponse.json({ error: "No icon" }, { status: 404 });
        return new Response(new Uint8Array(bytes), {
            headers: {
                "content-type": "image/png",
                // The panel busts this with the time the icon was set, so a new
                // one shows at once and an unchanged one is not re-read.
                "cache-control": "private, max-age=300"
            }
        });
    } catch {
        return NextResponse.json({ error: "No icon" }, { status: 404 });
    }
}

/** The eight bytes every PNG starts with, so a shell error never renders as one. */
function isPng(bytes: Buffer): boolean {
    return bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}
