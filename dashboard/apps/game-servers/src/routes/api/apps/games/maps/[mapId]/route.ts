import { z } from "zod";
import { NextResponse } from "next/server";
import { findMap } from "../../../../../../lib/minecraft/maps";
import { prepareMap, type MapDownload } from "../../../../../../lib/minecraft/map-store";
import { host } from "@polaris/app-host";

const { requirePermission } = host.session;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ mapId: string }> };

/**
 * Where a map's world stands on this instance, starting its download the first
 * time a server is built on it. The create and reset forms ask this until it is
 * ready, so the server's container finds the world already here. A route rather
 * than a server action because a form polls it, and an update renames every
 * action under an open tab.
 *
 * Read permission, because a reset is open to whoever may manage that one
 * server: what it can do is fetch one of the few archives the catalog names.
 */
export async function POST(_request: Request, { params }: Params): Promise<Response> {
    await requirePermission("games.read");
    const parsed = z
        .string()
        .trim()
        .min(1)
        .max(64)
        .safeParse((await params).mapId);
    const map = parsed.success ? findMap(parsed.data) : undefined;
    const answer: MapDownload = map ? await prepareMap(map) : { state: "failed", reason: "failed" };
    return NextResponse.json(answer, { headers: { "cache-control": "no-store" } });
}
