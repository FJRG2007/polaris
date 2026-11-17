// Where a delivered page's frame starts: the signed-in reader is checked here,
// with their cookie, and sent on to the page read by path under a pass of their
// own, so the files it references beside it resolve (see frame-pass.ts).
import { z } from "zod";
import { NextResponse } from "next/server";
import { guardedUser } from "@/lib/session";
import { framedUrl } from "@/lib/agents/artifacts/artifact-files";
import { mintFramePass } from "@/lib/agents/artifacts/frame-pass";
import { artifactDetail, mayReadArtifact } from "@/lib/agents/session-artifacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({ v: z.coerce.number().int().min(1).max(1_000_000) });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const id = z.string().uuid().safeParse((await params).id);
    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    const user = id.success && query.success ? await guardedUser({ touch: false }) : null;
    const allowed = id.success && user !== null && (await mayReadArtifact(user.id, id.data));
    const detail = allowed && id.success ? await artifactDetail(id.data) : null;
    if (!user || !detail || !query.success) {
        // i18n-ignore: status bodies no screen shows; the viewer says it in its own words
        return NextResponse.json({ error: "Not found" }, { status: 404, headers: { "cache-control": "no-store" } });
    }
    const base = `/api/agents/artifacts/${detail.artifact.id}/f/${mintFramePass(detail.artifact.id, user.id)}`;
    // Relative, so it stays on whichever address the reader came in through.
    return new Response(null, {
        status: 307,
        headers: { location: framedUrl(base, detail.artifact.path, query.data.v), "cache-control": "no-store" }
    });
}
