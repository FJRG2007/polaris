/**
 * A map's world, for a Minecraft server's container to download while it is
 * being created - behind the key its `WORLD` address carries (`mod-token`).
 *
 * A wrong key is the same answer as a missing file, so this does not say which
 * worlds exist to somebody who cannot have them.
 */

import { modTokenMatches } from "../../../../../../lib/minecraft/mod-token";
import { worldGet, worldHead } from "../../../../../../lib/minecraft/world-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string; file: string }> };

export async function HEAD(_request: Request, { params }: Params): Promise<Response> {
    const { token, file } = await params;
    if (!modTokenMatches(token)) return new Response(null, { status: 404 });
    return worldHead(file);
}

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const { token, file } = await params;
    if (!modTokenMatches(token)) return new Response("Not found", { status: 404 });
    return worldGet(file);
}
