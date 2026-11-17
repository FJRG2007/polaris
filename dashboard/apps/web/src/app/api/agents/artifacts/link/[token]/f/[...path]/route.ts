// A page shared by link, or a file beside it, read by path so its relative
// references resolve. The token is the whole of the right, judged again on
// every request; it reaches the page's own folder only (`frameReaches`).
import { artifactOfLink } from "@/lib/agents/session-artifacts";
import { serveFramed } from "@/lib/agents/artifacts/serve-artifact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ token: string; path: string[] }> }
) {
    const { token, path } = await params;
    return serveFramed(request, await artifactOfLink(token), path, false);
}
