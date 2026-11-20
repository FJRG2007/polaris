import { NextResponse } from "next/server";
import { backgroundUser, sessionCan } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One map tile for a location card, fetched by the server.
 *
 * Through Polaris rather than straight from the browser, so a reader's address
 * never reaches the tile service and the instance asks for each tile once. The
 * default is OpenStreetMap's own tiles, free and keyless under its usage policy
 * (identified, cached, light use, credited on the map). An instance that serves
 * its own tiles names them with `POLARIS_MAP_TILE_URL` (`{z}/{x}/{y}` template);
 * the address comes from the operator, never from the request, which supplies
 * three checked integers only.
 */
const DEFAULT_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const MAX_ZOOM = 19;
const TILE_BYTES = 512 * 1024;
const KEPT = 800;
const KEPT_MS = 7 * 24 * 60 * 60 * 1000;
const kept = new Map<string, { at: number; type: string; bytes: Uint8Array }>();

function template(): string {
    const configured = process.env.POLARIS_MAP_TILE_URL?.trim();
    return configured && /^https?:\/\//.test(configured) && configured.includes("{z}") ? configured : DEFAULT_TILES;
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
    _request: Request,
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
    // i18n-ignore: status bodies no screen shows
    if (z === null || x === null || y === null || z > MAX_ZOOM || x >= 2 ** z || y >= 2 ** z) {
        return NextResponse.json({ error: "No such tile" }, { status: 404 });
    }

    const key = `${z}/${x}/${y}`;
    const hit = kept.get(key);
    if (hit && Date.now() - hit.at < KEPT_MS) return served(hit.type, hit.bytes);

    const url = template().replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
    try {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(8_000),
            redirect: "error",
            headers: { "user-agent": "Polaris (self-hosted chat location tiles)", accept: "image/png,image/*" }
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
