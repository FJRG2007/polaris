/**
 * Directory listing as JSON, for the client-side Drive browser. Moving the list
 * off the server-rendered page means the Drive shell paints instantly and the
 * (sometimes slow, network-bound) listing streams in behind a skeleton instead
 * of blocking the whole navigation. Auth is re-checked here; the client is never
 * trusted. Node runtime because Prisma and the drivers need it.
 */

import { normalizeRelPath } from "@polaris/core";
import { userHasPermission } from "@polaris/auth";
import { requireUser } from "@/lib/session";
import { getDriver } from "@/lib/storage-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const user = await requireUser();
    if (!(await userHasPermission(user.id, "drive.read"))) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = new URL(request.url);
    const connectionId = url.searchParams.get("c");
    if (!connectionId) return Response.json({ error: "Missing connection" }, { status: 400 });

    let path: string;
    try {
        path = normalizeRelPath(url.searchParams.get("p") ?? "");
    } catch {
        return Response.json({ error: "Invalid path" }, { status: 400 });
    }

    const driver = await getDriver(connectionId, user.id);
    try {
        const listing = await driver.list(path);
        const entries = listing.entries.map((entry) => ({
            name: entry.name,
            path: entry.path,
            kind: entry.kind,
            size: entry.size.toString(),
            modifiedAt: entry.modifiedAt.toISOString()
        }));
        return Response.json({ entries });
    } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Unable to list this location";
        return Response.json({ error: message }, { status: 502 });
    } finally {
        await driver.dispose();
    }
}
