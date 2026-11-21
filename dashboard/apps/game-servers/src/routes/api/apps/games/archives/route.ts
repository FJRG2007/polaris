/**
 * A pack or world somebody brings to a Minecraft server: begin sending a file,
 * or hand over a link to download (`archives/store.ts`).
 *
 * Routes rather than server actions, like the map download: the form polls
 * them, a send outlives an update that renames every action under an open tab,
 * and a piece of a file is megabytes no action carries.
 *
 * Whoever may create or manage game servers, from Polaris's own pages only.
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import * as store from "../../../../../lib/minecraft/archives/store";
import { refuse, sameOrigin } from "../../../../../lib/minecraft/sounds-upload";

const { requirePermission } = host.session;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("from", [
    z.object({
        from: z.literal("file"),
        kind: z.enum(["pack", "world"]),
        name: z.string().trim().min(1).max(260),
        size: z.number().int().positive().max(store.MAX_ARCHIVE_BYTES)
    }),
    z.object({
        from: z.literal("link"),
        kind: z.enum(["pack", "world"]),
        url: z.string().trim().url().max(2000)
    })
]);

export async function POST(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return refuse(403, "forbidden");
    const user = await requirePermission("games.manage");
    const raw: unknown = await request.json().catch(() => null);
    // A size past the limit is answered as that, not as a malformed request.
    if (
        typeof raw === "object" &&
        raw !== null &&
        typeof (raw as { size?: unknown }).size === "number" &&
        (raw as { size: number }).size > store.MAX_ARCHIVE_BYTES
    )
        return refuse(413, "tooLarge");
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) return refuse(400, "failed");
    try {
        const id =
            parsed.data.from === "file"
                ? await store.startUpload(user.id, {
                      kind: parsed.data.kind,
                      name: parsed.data.name,
                      total: parsed.data.size
                  })
                : await store.importLink(user.id, { kind: parsed.data.kind, url: parsed.data.url });
        return Response.json(
            { id, chunkBytes: store.CHUNK_BYTES },
            { headers: { "cache-control": "no-store" } }
        );
    } catch (caught) {
        if (caught instanceof store.ArchiveRefusal) return refuse(400, caught.reason);
        console.error("[minecraft-archive] could not start:", caught);
        return refuse(500, "failed");
    }
}
