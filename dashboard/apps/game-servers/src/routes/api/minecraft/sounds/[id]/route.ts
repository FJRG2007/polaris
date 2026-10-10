/**
 * What Polaris's jar inside a Minecraft server hands its players: the sound
 * pack (its address, checksum and id, whether it is required, the line the
 * game shows when it asks and the one a player who turns it down is
 * disconnected with) and the sounds it plays on its own when somebody arrives.
 *
 * Not a session route: the caller is a server, proving which one with the token
 * its environment carries. Asked when the server starts and whenever the
 * dashboard tells it the library changed (`polaris sounds refresh`).
 */

import { z } from "zod";
import { authorizeServer, jarConfig } from "../../../../../lib/minecraft/sounds-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const reply = (status: number, content: unknown) =>
    Response.json(content, { status, headers: { "cache-control": "no-store" } });

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) return reply(401, { error: "unauthorized" });
    if (!(await authorizeServer(request, id))) return reply(401, { error: "unauthorized" });
    return reply(200, await jarConfig(id));
}
