/**
 * Read one file out of a container, for preview and download. Served as an
 * attachment so a file the container happens to serve as HTML cannot execute in
 * the dashboard's origin; the browser preview renders it as text, never as
 * markup.
 */

import { basename } from "node:path";
import { readFile } from "@/lib/container-service";
import { authorizeConnection, filesQuerySchema, parseQuery } from "../query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const parsed = parseQuery(request.url, filesQuerySchema);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

    const caller = await authorizeConnection(parsed.data.c);
    if (!caller) return Response.json({ error: "Forbidden" }, { status: 403 });

    try {
        const content = await readFile(parsed.data.c, caller.userId, parsed.data.id, parsed.data.p);
        const name = basename(parsed.data.p) || "file";
        return new Response(new Uint8Array(content), {
            headers: {
                "Content-Type": "application/octet-stream",
                "Content-Disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
                "Content-Length": String(content.byteLength)
            }
        });
    } catch (caught) {
        return Response.json(
            { error: caught instanceof Error ? caught.message : "Could not read this file" },
            { status: 502 }
        );
    }
}
