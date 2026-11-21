import { NextResponse } from "next/server";
import { backgroundUser, sessionCan } from "@/lib/session";
import { TILE_SOURCES, type TileSource } from "@/lib/map-layers";
import {
    TILE_HEADERS,
    activeImagery,
    customImageryTemplate,
    keyedTileUrl,
    noteImageryFailure,
    noteImagerySuccess
} from "@/lib/map-imagery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One map tile for a location card, fetched by the server.
 *
 * Through Polaris rather than straight from the browser, so a reader's address
 * and what they look at never reach the tile service, a provider key never
 * reaches a browser, and the instance asks for each tile once. The `?layer=`
 * picks the source (`lib/map-layers.ts`): OpenStreetMap's streets by default, or
 * the satellite imagery and its labels overlay. Imagery comes from the provider
 * an administrator chose (`lib/map-imagery.ts`) - the free Sentinel-2 default
 * unless a keyed one is set - and a keyed tile that fails is answered from the
 * default instead, marked with `x-polaris-imagery-fallback`. An instance that
 * serves its own tiles names them with the source's env key (`{z}/{x}/{y}`
 * template); the address comes from the operator, never from the request, which
 * supplies a known layer name and three checked integers only (`?v=` only
 * separates browser caches between providers and is not read).
 */
const TILE_BYTES = 512 * 1024;
const KEPT = 800;
const KEPT_MS = 7 * 24 * 60 * 60 * 1000;
/** A keyed provider's tiles are kept a day: what people looked at, not an offline copy. */
const KEYED_KEPT_MS = 24 * 60 * 60 * 1000;
const kept = new Map<string, { at: number; ttl: number; type: string; bytes: Uint8Array }>();

function template(source: TileSource): string {
    if (source === "imagery") return customImageryTemplate() ?? TILE_SOURCES.imagery.template;
    const info = TILE_SOURCES[source];
    const configured = process.env[info.env]?.trim();
    return configured && /^https?:\/\//.test(configured) && configured.includes("{z}") ? configured : info.template;
}

function sourceOf(request: Request): TileSource | null {
    const layer = new URL(request.url).searchParams.get("layer") ?? "streets";
    return Object.hasOwn(TILE_SOURCES, layer) ? (layer as TileSource) : null;
}

function int(value: string): number | null {
    return /^\d{1,7}$/.test(value) ? Number(value) : null;
}

function served(type: string, bytes: Uint8Array, headers: Record<string, string> = {}): Response {
    return new Response(Buffer.from(bytes), {
        headers: { "content-type": type, "cache-control": "private, max-age=86400", ...headers }
    });
}

class TileError extends Error {
    constructor(readonly status: number | null) {
        super(`tile ${status ?? "unreachable"}`);
    }
}

async function fetchTile(url: string): Promise<{ type: string; bytes: Uint8Array }> {
    let response: Response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(8_000), redirect: "error", headers: TILE_HEADERS });
    } catch {
        throw new TileError(null);
    }
    const type = response.headers.get("content-type") ?? "";
    // Esri answers a refused token with a 200 and a JSON body.
    if (!response.ok || !type.startsWith("image/")) throw new TileError(response.ok ? 498 : response.status);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > TILE_BYTES) throw new TileError(null);
    return { type, bytes };
}

function keep(key: string, ttl: number, tile: { type: string; bytes: Uint8Array }): void {
    if (kept.size >= KEPT) kept.delete(kept.keys().next().value as string);
    kept.set(key, { at: Date.now(), ttl, ...tile });
}

function fromCache(key: string): { type: string; bytes: Uint8Array } | null {
    const hit = kept.get(key);
    return hit && Date.now() - hit.at < hit.ttl ? hit : null;
}

/** The free default's tile, cached as always; null when it has none at this zoom or fails. */
async function defaultTile(z: number, x: number, y: number): Promise<{ type: string; bytes: Uint8Array } | null> {
    if (z > TILE_SOURCES.imagery.nativeMaxZoom) return null;
    const key = `imagery/${z}/${x}/${y}`;
    const hit = fromCache(key);
    if (hit) return hit;
    const url = TILE_SOURCES.imagery.template.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
    try {
        const tile = await fetchTile(url);
        keep(key, KEPT_MS, tile);
        return tile;
    } catch {
        return null;
    }
}

export async function GET(
    request: Request,
    { params }: { params: Promise<{ z: string; x: string; y: string }> }
): Promise<Response> {
    const session = await backgroundUser();
    // i18n-ignore: status bodies no screen shows
    if (!session || !(await sessionCan(session, "chat.use"))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const raw = await params;
    const z = int(raw.z);
    const x = int(raw.x);
    const y = int(raw.y.replace(/\.png$/, ""));
    const source = sourceOf(request);
    const imagery = source === "imagery" ? await activeImagery() : null;
    const deepest = imagery ? imagery.view.nativeMaxZoom : source ? TILE_SOURCES[source].nativeMaxZoom : 0;
    // i18n-ignore: status bodies no screen shows
    if (source === null || z === null || x === null || y === null || z > deepest || x >= 2 ** z || y >= 2 ** z) {
        return NextResponse.json({ error: "No such tile" }, { status: 404 });
    }

    if (imagery?.kind === "keyed") {
        const key = `${imagery.view.version}/${z}/${x}/${y}`;
        const hit = fromCache(key);
        if (hit) return served(hit.type, hit.bytes);
        try {
            const tile = await fetchTile(keyedTileUrl(imagery.provider, imagery.key, z, x, y));
            keep(key, KEYED_KEPT_MS, tile);
            await noteImagerySuccess(imagery);
            return served(tile.type, tile.bytes);
        } catch (caught) {
            const reason = await noteImageryFailure(imagery, caught instanceof TileError ? caught.status : null);
            const fallback = await defaultTile(z, x, y);
            // i18n-ignore: status bodies no screen shows
            if (!fallback) return NextResponse.json({ error: "Tile unavailable" }, { status: 502 });
            // Briefly: the provider may answer again, and this tile should then be its own.
            return served(fallback.type, fallback.bytes, {
                "cache-control": "private, max-age=60",
                "x-polaris-imagery-fallback": reason
            });
        }
    }

    // The instance's own imagery is kept apart from the default's, which a keyed fallback fills.
    const key = `${imagery?.kind === "custom" ? "custom" : source}/${z}/${x}/${y}`;
    const hit = fromCache(key);
    if (hit) return served(hit.type, hit.bytes);

    const url = template(source).replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
    try {
        const tile = await fetchTile(url);
        keep(key, KEPT_MS, tile);
        return served(tile.type, tile.bytes);
    } catch {
        // i18n-ignore: status bodies no screen shows
        return NextResponse.json({ error: "Tile unavailable" }, { status: 502 });
    }
}
