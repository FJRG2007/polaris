// A delivered page, or a file beside it, read by path under the reader's pass:
// the frame's origin is opaque, so no cookie arrives here. The pass names who,
// and whether they may still read the page is asked again on every request.
import { z } from "zod";
import { artifactReach } from "@/lib/agents/session-artifacts";
import { readFramePass } from "@/lib/agents/artifacts/frame-pass";
import { serveFramed } from "@/lib/agents/artifacts/serve-artifact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string; pass: string; path: string[] }> }
) {
    const { id: raw, pass, path } = await params;
    const id = z.string().uuid().safeParse(raw);
    const userId = id.success ? readFramePass(id.data, pass) : null;
    const reach = id.success && userId ? await artifactReach(userId, id.data) : null;
    return serveFramed(request, reach && id.success ? id.data : null, path, reach === "session");
}
