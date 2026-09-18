import { NextResponse } from "next/server";
import { modItemIcon } from "../../../../../../../../lib/minecraft/mod-items-service";
import { host } from "@polaris/app-host";

const { requireGameServer } = host.appsInstallAccess;

export const runtime = "nodejs";

/**
 * One modded item's picture, out of what was read from the mod's jar.
 *
 * Addressed by the build it came from and the texture it was filed under, both
 * checked before either reaches the disk - they arrive in a query string, and
 * what they are about to name is a path.
 *
 * Cached hard, because the address says what the bytes are: the build is the
 * jar's own hash, so a picture at one of these addresses cannot change without
 * the address changing with it.
 */
const CACHE_SECONDS = 7 * 24 * 3600;

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const { id } = await params;
    await requireGameServer("games.read", id);

    const asked = new URL(request.url).searchParams;
    const bytes = await modItemIcon(asked.get("build") ?? "", asked.get("name") ?? "");
    if (bytes === null) return new NextResponse(null, { status: 404 });

    return new NextResponse(new Uint8Array(bytes), {
        headers: {
            "Content-Type": "image/png",
            "Cache-Control": `private, max-age=${CACHE_SECONDS}, immutable`,
            // Somebody else's file, rendered inside a dashboard an operator is
            // logged into. Nothing here is allowed to be treated as a document.
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "X-Content-Type-Options": "nosniff"
        }
    });
}
