import { NextResponse } from "next/server";
import { activeImagery } from "@/lib/map-imagery";
import type { ImageryView } from "@/lib/map-layers";
import { backgroundUser, sessionCan } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the map should know about the satellite imagery in use: how deep it is
 * drawn, whose credit it carries, and a version that separates browser caches.
 * Never the key, and never the provider's address - tiles still come through
 * `/api/chat/location/tile`.
 */
export async function GET(): Promise<Response> {
    const session = await backgroundUser();
    // i18n-ignore: status bodies no screen shows
    if (!session || !(await sessionCan(session, "chat.use"))) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { view } = await activeImagery();
    const body: ImageryView = {
        provider: view.provider,
        nativeMaxZoom: view.nativeMaxZoom,
        credits: view.credits,
        version: view.version
    };
    return NextResponse.json(body, { headers: { "cache-control": "private, max-age=60" } });
}
