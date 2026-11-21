/**
 * One send of a pack or world (`archives/store.ts`): a piece of the file (PUT,
 * `?offset=`), every piece in (POST), where it stands (GET), or stop (DELETE).
 * Only the person who began it can see or touch it; anybody else is told there
 * is nothing by that id.
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import * as store from "../../../../../../lib/minecraft/archives/store";
import { bounded } from "../../../../../../lib/minecraft/mod-items-service";
import { refuse, sameOrigin } from "../../../../../../lib/minecraft/sounds-upload";

const { requirePermission } = host.session;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const NO_STORE = { "cache-control": "no-store" };

async function idOf(params: Params["params"]): Promise<string | null> {
    const parsed = z.string().uuid().safeParse((await params).id);
    return parsed.success ? parsed.data : null;
}

function failed(caught: unknown): Response {
    if (caught instanceof store.ArchiveRefusal)
        return refuse(caught.reason === "notFound" ? 404 : 400, caught.reason);
    console.error("[minecraft-archive] send failed:", caught);
    return refuse(500, "failed");
}

export async function PUT(request: Request, { params }: Params): Promise<Response> {
    if (!sameOrigin(request)) return refuse(403, "forbidden");
    const user = await requirePermission("games.manage");
    const id = await idOf(params);
    const offset = Number(new URL(request.url).searchParams.get("offset"));
    if (!id || !Number.isSafeInteger(offset) || offset < 0) return refuse(400, "failed");
    if (Number(request.headers.get("content-length") ?? "0") > store.CHUNK_BYTES)
        return refuse(413, "tooLarge");
    if (!request.body) return refuse(400, "empty");
    const bytes = await bounded(request.body, store.CHUNK_BYTES);
    if (bytes === null) return refuse(413, "tooLarge");
    try {
        return Response.json(await store.appendPiece(user.id, id, offset, bytes), { headers: NO_STORE });
    } catch (caught) {
        return failed(caught);
    }
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
    if (!sameOrigin(request)) return refuse(403, "forbidden");
    const user = await requirePermission("games.manage");
    const id = await idOf(params);
    if (!id) return refuse(404, "notFound");
    try {
        return Response.json(store.finishUpload(user.id, id), { headers: NO_STORE });
    } catch (caught) {
        return failed(caught);
    }
}

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const user = await requirePermission("games.manage");
    const id = await idOf(params);
    if (!id) return refuse(404, "notFound");
    try {
        return Response.json(store.jobStatus(user.id, id), { headers: NO_STORE });
    } catch (caught) {
        return failed(caught);
    }
}

export async function DELETE(request: Request, { params }: Params): Promise<Response> {
    if (!sameOrigin(request)) return refuse(403, "forbidden");
    const user = await requirePermission("games.manage");
    const id = await idOf(params);
    if (!id) return refuse(404, "notFound");
    try {
        await store.cancelJob(user.id, id);
        return new Response(null, { status: 204, headers: NO_STORE });
    } catch (caught) {
        return failed(caught);
    }
}
