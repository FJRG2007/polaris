// One deliverable's bytes, for a signed-in reader who may read it.
import { z } from "zod";
import { guardedUser } from "@/lib/session";
import { mayReadArtifact } from "@/lib/agents/session-artifacts";
import { serveArtifact } from "@/lib/agents/artifacts/serve-artifact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const id = z.string().uuid().safeParse((await params).id);
    const user = id.success ? await guardedUser({ touch: false }) : null;
    const allowed = id.success && user !== null && (await mayReadArtifact(user.id, id.data));
    return serveArtifact(request, allowed && id.success ? id.data : null);
}
