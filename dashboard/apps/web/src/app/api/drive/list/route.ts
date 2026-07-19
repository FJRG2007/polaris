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
import { getDriver, SmbShareRequiredError } from "@/lib/storage-service";
import { getMetaMap } from "@/lib/drive-meta-service";

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

    let driver;
    try {
        driver = await getDriver(connectionId, user.id);
    } catch (caught) {
        // A UNAS with no SMB share yet: tell the client to ask for the share name
        // rather than surfacing a generic failure (credentials are reused).
        if (caught instanceof SmbShareRequiredError) {
            return Response.json({ needsSmbShare: true });
        }
        const message = caught instanceof Error ? caught.message : "Unable to connect";
        return Response.json({ error: message }, { status: 502 });
    }

    try {
        const listing = await driver.list(path);
        const meta = await getMetaMap(
            connectionId,
            listing.entries.map((entry) => entry.path)
        );
        const entries = listing.entries.map((entry) => {
            const item = meta.get(entry.path);
            return {
                name: entry.name,
                path: entry.path,
                kind: entry.kind,
                size: entry.size.toString(),
                modifiedAt: entry.modifiedAt.toISOString(),
                hidden: item?.hidden ?? false,
                icon: item?.icon ?? null,
                iconColor: item?.iconColor ?? null,
                note: item?.note ?? null
            };
        });
        return Response.json({ entries });
    } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Unable to list this location";
        return Response.json({ error: message }, { status: 502 });
    } finally {
        await driver.dispose();
    }
}
