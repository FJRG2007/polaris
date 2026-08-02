/**
 * Browse a directory inside a container. The listing is read-only: the local
 * host runs it through the daemon's allowlisted fs endpoint, and a remote engine
 * runs the same `ls` as a one-shot exec. A path that does not exist answers with
 * the reason the container gave, so an unreadable directory does not render as
 * an empty one.
 */

import { listFiles } from "@/lib/container-service";
import { authorizeConnection, filesQuerySchema, parseQuery } from "../query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const parsed = parseQuery(request.url, filesQuerySchema);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

    const caller = await authorizeConnection(parsed.data.c);
    if (!caller) return Response.json({ error: "Forbidden" }, { status: 403 });

    try {
        const entries = await listFiles(parsed.data.c, caller.userId, parsed.data.id, parsed.data.p);
        return Response.json({ entries });
    } catch (caught) {
        return Response.json(
            { error: caught instanceof Error ? caught.message : "Could not list this directory" },
            { status: 502 }
        );
    }
}
