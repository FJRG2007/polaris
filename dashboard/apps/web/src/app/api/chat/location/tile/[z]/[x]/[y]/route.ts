import { NextResponse } from "next/server";
import { backgroundUser, sessionCan } from "@/lib/session";
import { TILE_SOURCES, type TileSource } from "@/lib/map-layers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One map tile for a location card, fetched by the server.
 *
 * Through Polaris rather than straight from the browser, so a reader's address
 * never reaches the tile service and the instance asks for each tile once. The
 * `?layer=` picks the source (`lib/map-layers.ts`): OpenStreetMap's streets by
 * default, or the satellite imagery and its labels overlay - each free and
 * keyless, credited on the map. An instance that serves its own tiles names them
 * with the source's env key (`{z}/{x}/{y}` template); the address comes from the
 * operator, never from the request, which supplies a known layer name and three
 * checked integers only.
 */
const TILE_BYTES = 512 * 1024;
const KEPT = 800;
const KEPT_MS = 7 * 24 * 60 * 60 * 1000;
const kept = new Map<string, { at: number; type: string; bytes: Uint8Array }>();

function template(source: TileSource): string {
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

function served(type: string, bytes: Uint8Array): Response {
    return new Response(Buffer.from(bytes), {
        headers: { "content-type": type, "cache-control": "private, max-age=86400" }
    });
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
    // i18n-ignore: status bodies no screen shows
    if (source === null || z === null || x === null || y === null || z > TILE_SOURCES[source].nativeMaxZoom || x >= 2 ** z || y >= 2 ** z) {
        return NextResponse.json({ error: "No such tile" }, { status: 404 });
    }

    const key = `${source}/${z}/${x}/${y}`;
    const hit = kept.get(key);
    if (hit && Date.now() - hit.at < KEPT_MS) return served(hit.type, hit.bytes);

    const url = template(source).replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
    try {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(8_000),
            redirect: "error",
            headers: { "user-agent": "Polaris (self-hosted chat location tiles)", accept: "image/png,image/jpeg,image/*" }
        });
        const type = response.headers.get("content-type") ?? "";
        if (!response.ok || !type.startsWith("image/")) throw new Error(`tile ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > TILE_BYTES) throw new Error("tile too large");
        if (kept.size >= KEPT) kept.delete(kept.keys().next().value as string);
        kept.set(key, { at: Date.now(), type, bytes });
        return served(type, bytes);
    } catch {
        // i18n-ignore: status bodies no screen shows
        return NextResponse.json({ error: "Tile unavailable" }, { status: 502 });
    }
}
