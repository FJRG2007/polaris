/**
 * A map's resource pack, for a player's game client. Public, because the client
 * asks with no credential of any kind; only the packs `maps.ts` names are served,
 * and downloads are counted per address.
 */

import { packGet, packHead } from "../../../../../lib/minecraft/world-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ file: string }> };

export async function HEAD(_request: Request, { params }: Params): Promise<Response> {
    const { file } = await params;
    return packHead(file);
}

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const { file } = await params;
    return packGet(file);
}
