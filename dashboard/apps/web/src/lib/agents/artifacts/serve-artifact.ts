/**
 * An artifact's bytes as a response, for the signed-in reader and for a link
 * alike. Served under `ARTIFACT_CSP`, so nothing an agent wrote runs as this
 * origin. Server-only.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { framedArtifact, readArtifactVersion } from "@/lib/agents/session-artifacts";
import { artifactFramePath, artifactHeaders } from "./artifact-files";

const querySchema = z.object({
    v: z.coerce.number().int().min(1).max(1_000_000).optional(),
    download: z.enum(["0", "1"]).optional()
});

const NO_STORE = { "cache-control": "no-store" };

export async function serveArtifact(request: Request, artifactId: string | null): Promise<Response> {
    // i18n-ignore: status bodies no screen shows; the viewer says it in its own words
    if (!artifactId) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
    const url = new URL(request.url);
    const query = querySchema.safeParse(Object.fromEntries(url.searchParams));
    // i18n-ignore: status bodies no screen shows
    if (!query.success) return NextResponse.json({ error: "Bad request" }, { status: 400, headers: NO_STORE });
    return respond(artifactId, query.data.v ?? null, query.data.download === "1", false);
}

/**
 * A delivered page, or a file beside it, read by path (`segments`, as the
 * route received them) from the page `anchorId`, so a relative reference in
 * the page resolves to the file next to it. `wholeSession` says whether the
 * reader may read the page's whole session or only the page
 * (`frameReaches`). A step out of the folder is refused as not found.
 */
export async function serveFramed(
    request: Request,
    anchorId: string | null,
    segments: readonly string[],
    wholeSession: boolean
): Promise<Response> {
    const path = artifactFramePath(segments);
    // i18n-ignore: status bodies no screen shows; the viewer says it in its own words
    if (!anchorId || !path) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    // i18n-ignore: status bodies no screen shows
    if (!query.success) return NextResponse.json({ error: "Bad request" }, { status: 400, headers: NO_STORE });
    const target = await framedArtifact(anchorId, path, wholeSession, query.data.v ?? null).catch((error) => {
        console.error(`[agent-artifact] ${anchorId}: could not find ${JSON.stringify(path)} beside it:`, error);
        return null;
    });
    // i18n-ignore: status bodies no screen shows
    if (!target) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
    return respond(target.artifactId, target.version, false, true);
}

async function respond(artifactId: string, version: number | null, download: boolean, framed: boolean) {
    const file = await readArtifactVersion(artifactId, version).catch((error) => {
        console.error(`[agent-artifact] ${artifactId}: could not read it:`, error);
        return null;
    });
    // i18n-ignore: status bodies no screen shows
    if (!file) return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
    return new Response(file.body, {
        headers: artifactHeaders({
            mediaType: file.mediaType,
            name: file.name,
            size: file.size,
            download,
            immutable: version !== null,
            framed
        })
    });
}
