/**
 * One container's details: image, command, ports, mounts, networks and the env
 * keys it was given. Values of those keys are dropped in the driver - an env
 * list is where a container's secrets live, and knowing which knobs exist is
 * what the panel is for.
 */

import { inspectContainer } from "@/lib/container-service";
import { authorizeConnection, inspectQuerySchema, parseQuery } from "../query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const parsed = parseQuery(request.url, inspectQuerySchema);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

    const caller = await authorizeConnection(parsed.data.c);
    if (!caller) return Response.json({ error: "Forbidden" }, { status: 403 });

    try {
        const detail = await inspectContainer(parsed.data.c, caller.userId, parsed.data.id, {
            size: parsed.data.size
        });
        return Response.json({ detail });
    } catch (caught) {
        return Response.json(
            { error: caught instanceof Error ? caught.message : "Could not inspect this container" },
            { status: 502 }
        );
    }
}
