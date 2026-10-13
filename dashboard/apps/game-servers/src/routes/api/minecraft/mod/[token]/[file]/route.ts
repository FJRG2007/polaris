/**
 * Polaris's jars, for a Minecraft server's image to download - behind the key a
 * server's `MODS` address carries (`mod-token`).
 *
 * A wrong key is the same answer as a missing file: this does not say which jars
 * exist to somebody who cannot have them. Even with the key a download is
 * counted per address, since a key copied out of a server's settings is still
 * somebody else's bandwidth.
 */

import { modTokenMatches } from "../../../../../../lib/minecraft/mod-token";
import { jarGet, jarHead, type DownloadLimit } from "../../../../../../lib/minecraft/mod-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string; file: string }> };

/** A server boots a few times in ten minutes while somebody is fixing it, and
 *  several servers can sit behind one address. */
const LIMIT: DownloadLimit = {
    bucket: "mc-mod-get",
    perAddress: 30,
    overall: 60,
    windowMs: 10 * 60_000
};

export async function HEAD(_request: Request, { params }: Params): Promise<Response> {
    const { token, file } = await params;
    if (!modTokenMatches(token)) return new Response(null, { status: 404 });
    return jarHead(file);
}

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const { token, file } = await params;
    if (!modTokenMatches(token)) return new Response("Not found", { status: 404 });
    return jarGet(file, LIMIT);
}
