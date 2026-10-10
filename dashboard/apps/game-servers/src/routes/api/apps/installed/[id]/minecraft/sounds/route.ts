/**
 * A new sound for one server, uploaded from its Sounds tab.
 *
 * A route rather than an action because an action carries a megabyte and a
 * sound can be eight. The body is the file itself, already Ogg Vorbis (the
 * browser converts anything else first); the name is in the query. Nothing
 * about it is trusted: it is read up to the limit and no further, and checked
 * page by page as the game will read it (`readVorbis`) before it is kept.
 *
 * The server's managers only, and only from Polaris's own pages, as with an
 * action. A running server is told to hand the new pack out at once.
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import * as service from "../../../../../../../lib/minecraft/sounds-service";
import { readUpload, refuse, sameOrigin } from "../../../../../../../lib/minecraft/sounds-upload";
import { gameWords, messageText } from "../../../../../../../screens/game-words";

const { requireGameServer } = host.appsInstallAccess;
const { recordAudit } = host.auditService;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const t = await gameWords("minecraft");
    const { id } = await params;
    if (!sameOrigin(request)) return refuse(403, t("sounds.refused.noAccess"));
    if (!z.string().uuid().safeParse(id).success) return refuse(404, t("sounds.refused.noAccess"));
    let resolved: Awaited<ReturnType<typeof requireGameServer>>;
    try {
        resolved = await requireGameServer("games.manage", id);
    } catch {
        return refuse(403, t("sounds.refused.noAccess"));
    }
    const name = new URL(request.url).searchParams.get("name") ?? "";
    const body = await readUpload(request);
    if (body === null) return refuse(413, t("sounds.refused.tooLarge"));
    if (body === "empty") return refuse(400, t("sounds.refused.empty"));
    try {
        const sound = await service.addSound(id, { name, bytes: body });
        await recordAudit({
            actorId: resolved.user.id,
            action: "minecraft.sounds.add",
            targetType: "installedApp",
            targetId: id,
            metadata: { key: sound.key }
        });
        const pushed = await service.refreshServer(resolved.access.ownerId, id);
        return Response.json({ sound, pushed }, { headers: { "cache-control": "no-store" } });
    } catch (caught) {
        if (caught instanceof service.SoundRefusal) return refuse(400, await messageText(caught.message));
        console.error("[minecraft-sounds] upload failed:", caught);
        return refuse(500, t("sounds.refused.failed"));
    }
}
