/**
 * An artifact's bytes as a response, for the signed-in reader and for a link
 * alike. Served under `ARTIFACT_CSP`, so nothing an agent wrote runs as this
 * origin. Server-only.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { readArtifactVersion } from "@/lib/agents/session-artifacts";
import { artifactHeaders } from "./artifact-files";

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
    const file = await readArtifactVersion(artifactId, query.data.v ?? null).catch((error) => {
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
            download: query.data.download === "1",
            immutable: query.data.v !== undefined
        })
    });
}
