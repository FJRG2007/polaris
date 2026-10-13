/**
 * The address Polaris's jars were served from before it carried a key.
 *
 * Kept only for a server whose `MODS` has not been rewritten yet: the component
 * sweep moves every server to the keyed address (`[token]/[file]`) within
 * minutes of an update, and a server that boots in between would otherwise not
 * start. Nobody else has a reason to be here, so it is held to a handful of
 * downloads - per address, and for everybody together - instead of serving
 * megabytes to whoever asks as often as they like.
 */

import { jarGet, jarHead, type DownloadLimit } from "../../../../../lib/minecraft/mod-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ file: string }> };

const LIMIT: DownloadLimit = {
    bucket: "mc-mod-legacy",
    perAddress: 4,
    overall: 8,
    windowMs: 60 * 60_000
};

export async function HEAD(_request: Request, { params }: Params): Promise<Response> {
    const { file } = await params;
    return jarHead(file);
}

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const { file } = await params;
    return jarGet(file, LIMIT);
}
