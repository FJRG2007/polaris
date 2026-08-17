/**
 * The picture an event kept.
 *
 * Served through Polaris rather than by a link into the storage it landed on: it
 * may be on a NAS nobody outside the house can reach, and it is a photograph of
 * somebody's doorstep either way.
 */

import { prisma } from "@polaris/db";
import { readStill } from "@/lib/home/stills";
import { homeInstall } from "@/lib/home/access";
import { requireUser, sessionCan } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    const user = await requireUser();
    if (!(await sessionCan(user, "home.read"))) return new Response("Forbidden", { status: 403 });
    const install = await homeInstall();
    if (!install) return new Response("Not found", { status: 404 });

    const { id } = await context.params;
    // Scoped through this house's cameras, so an event id from anywhere else
    // resolves to nothing.
    const event = await prisma.cameraEvent.findFirst({
        where: { id, camera: { installedAppId: install.id } },
        select: { stillKey: true }
    });
    if (!event?.stillKey) return new Response("Not found", { status: 404 });

    const image = await readStill(event.stillKey);
    if (!image) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(image), {
        headers: {
            "content-type": "image/jpeg",
            // A past moment never changes, so it is worth caching properly - but
            // only in the reader's own browser.
            "cache-control": "private, max-age=86400"
        }
    });
}
