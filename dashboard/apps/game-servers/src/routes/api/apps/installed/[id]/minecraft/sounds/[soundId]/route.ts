/**
 * One of a server's sounds: its file, for the Sounds tab's player, and a new
 * file put under it.
 *
 * Listening is for anybody who can see the server; replacing is its managers',
 * from Polaris's own pages only, read and checked exactly as an upload is.
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import * as service from "../../../../../../../../lib/minecraft/sounds-service";
import { gameWords, messageText } from "../../../../../../../../screens/game-words";
import { readUpload, refuse, sameOrigin } from "../../../../../../../../lib/minecraft/sounds-upload";

const { requireGameServer } = host.appsInstallAccess;
const { recordAudit } = host.auditService;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; soundId: string }> };

const ids = z.object({ id: z.string().uuid(), soundId: z.string().uuid() });

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const t = await gameWords("minecraft");
    const parsed = ids.safeParse(await params);
    if (!parsed.success) return refuse(404, t("sounds.refused.gone"));
    try {
        await requireGameServer("games.read", parsed.data.id);
    } catch {
        return refuse(403, t("sounds.refused.noAccess"));
    }
    const bytes = await service.soundFile(parsed.data.id, parsed.data.soundId);
    if (!bytes) return refuse(404, t("sounds.refused.gone"));
    return new Response(new Uint8Array(bytes), {
        headers: {
            "content-type": "audio/ogg",
            "content-length": String(bytes.length),
            "x-content-type-options": "nosniff",
            // The screen asks again with the time it changed, so a replaced file
            // is heard at once.
            "cache-control": "private, max-age=3600"
        }
    });
}

export async function PUT(request: Request, { params }: Params): Promise<Response> {
    const t = await gameWords("minecraft");
    if (!sameOrigin(request)) return refuse(403, t("sounds.refused.noAccess"));
    const parsed = ids.safeParse(await params);
    if (!parsed.success) return refuse(404, t("sounds.refused.gone"));
    let resolved: Awaited<ReturnType<typeof requireGameServer>>;
    try {
        resolved = await requireGameServer("games.manage", parsed.data.id);
    } catch {
        return refuse(403, t("sounds.refused.noAccess"));
    }
    const body = await readUpload(request);
    if (body === null) return refuse(413, t("sounds.refused.tooLarge"));
    if (body === "empty") return refuse(400, t("sounds.refused.empty"));
    try {
        const sound = await service.replaceSound(parsed.data.id, parsed.data.soundId, body);
        await recordAudit({
            actorId: resolved.user.id,
            action: "minecraft.sounds.replace",
            targetType: "installedApp",
            targetId: parsed.data.id,
            metadata: { key: sound.key }
        });
        const pushed = await service.refreshServer(resolved.access.ownerId, parsed.data.id);
        return Response.json({ sound, pushed }, { headers: { "cache-control": "no-store" } });
    } catch (caught) {
        if (caught instanceof service.SoundRefusal) return refuse(400, await messageText(caught.message));
        console.error("[minecraft-sounds] replace failed:", caught);
        return refuse(500, t("sounds.refused.failed"));
    }
}
