/**
 * A recorded clip, played back.
 *
 * Streamed through Polaris rather than linked to on its storage: the file may be
 * on a NAS nobody outside the house can reach, and it is footage of somebody's
 * home either way. Range requests are answered, because without them a browser
 * can only play from the start - it cannot scrub.
 */

import { homeInstall } from "@/lib/home/access";
import { openClip } from "@/lib/home/recording";
import { requireUser, sessionCan } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RANGE = /^bytes=(\d+)-(\d*)$/;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    const user = await requireUser();
    if (!(await sessionCan(user, "home.read"))) return new Response("Forbidden", { status: 403 });
    const install = await homeInstall();
    if (!install) return new Response("Not found", { status: 404 });

    const { id } = await context.params;
    const match = RANGE.exec(request.headers.get("range") ?? "");
    const start = match ? Number.parseInt(match[1] ?? "0", 10) : 0;
    const end = match?.[2] ? Number.parseInt(match[2], 10) : undefined;

    const clip = await openClip(install.id, id, match ? { start, ...(end === undefined ? {} : { end }) } : undefined);
    if (!clip) return new Response("Not found", { status: 404 });

    const last = end ?? clip.bytes - 1;
    const headers: Record<string, string> = {
        "content-type": "video/mp4",
        "accept-ranges": "bytes",
        // Footage of a house, served to one signed-in person. Never a shared
        // cache.
        "cache-control": "private, max-age=3600"
    };
    if (match) {
        headers["content-range"] = `bytes ${start}-${last}/${clip.bytes}`;
        headers["content-length"] = String(Math.max(0, last - start + 1));
    } else {
        headers["content-length"] = String(clip.bytes);
    }

    // The driver holds a session, so it is released once the body is done with -
    // whether the viewer watched the whole clip or closed the tab.
    const body = clip.stream.pipeThrough(
        new TransformStream({
            flush: () => void clip.dispose()
        })
    );
    return new Response(body, { status: match ? 206 : 200, headers });
}
