import { NextResponse } from "next/server";
import { soundPreview } from "../../../../../../../lib/minecraft/sound-preview";
import { host } from "@polaris/app-host";

const { requireGameServer } = host.appsInstallAccess;

export const runtime = "nodejs";

/**
 * One of the Announce screen's sounds, to hear before sending it. Behind the same
 * grant as sending one; only the sounds on that screen's list are served - see
 * `sound-preview`.
 */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const { id } = await params;
    await requireGameServer("games.console", id);
    const sound = new URL(request.url).searchParams.get("id") ?? "";
    const bytes = await soundPreview(sound).catch(() => null);
    if (!bytes) return new NextResponse(null, { status: 404 });
    return new NextResponse(new Uint8Array(bytes), {
        headers: {
            "content-type": "audio/ogg",
            "content-length": String(bytes.byteLength),
            "cache-control": "private, max-age=86400",
            "x-content-type-options": "nosniff"
        }
    });
}
