/**
 * One server's sound pack, as the players' game downloads it.
 *
 * Reached with a token rather than a session: the game asks with no account and
 * no cookie. The token is derived from this instance's own secret over the
 * server's id (`soundPackToken`), so the address cannot be guessed from the id.
 * What it hands out is exactly what every player on that server is handed
 * anyway.
 *
 * Two names: `<sha1>.zip`, the pack the server's jar pushed, which never
 * changes and is cached for good - a checksum that is no longer the library's
 * is answered 404 rather than with other bytes, which the game would only
 * refuse; and `latest.zip`, the newest pack, for a server that offers it as its
 * own resource pack and so cannot say which one it is.
 */

import { z } from "zod";
import { currentPack, soundPackTokenMatches } from "../../../../../../../lib/minecraft/sounds-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILE = /^(latest|[0-9a-f]{40})\.zip$/;

type Params = { params: Promise<{ id: string; token: string; file: string }> };

const missing = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const { id, token, file } = await params;
    const named = FILE.exec(file);
    if (!named || !z.string().uuid().safeParse(id).success) return missing();
    if (!soundPackTokenMatches(id, token)) return missing();
    const pack = await currentPack(id).catch(() => null);
    if (!pack) return missing();
    const latest = named[1] === "latest";
    if (!latest && named[1] !== pack.sha1) return missing();
    return new Response(new Uint8Array(pack.bytes), {
        headers: {
            "content-type": "application/zip",
            "content-length": String(pack.bytes.length),
            "content-disposition": `attachment; filename="polaris-sounds.zip"`,
            "x-content-type-options": "nosniff",
            etag: `"${pack.sha1}"`,
            "cache-control": latest ? "no-store" : "public, max-age=31536000, immutable"
        }
    });
}

export async function HEAD(request: Request, context: Params): Promise<Response> {
    const answer = await GET(request, context);
    return new Response(null, { status: answer.status, headers: answer.headers });
}
