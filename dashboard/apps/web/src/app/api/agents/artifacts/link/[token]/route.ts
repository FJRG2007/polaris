// One deliverable's bytes through a link to it (`/k/<token>`): the token is the
// whole of the right, judged again on every request by `linkReach`.
import { artifactOfLink } from "@/lib/agents/session-artifacts";
import { serveArtifact } from "@/lib/agents/artifacts/serve-artifact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    return serveArtifact(request, await artifactOfLink(token));
}
