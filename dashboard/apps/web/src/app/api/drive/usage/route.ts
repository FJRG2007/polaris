/**
 * Storage usage (total / used / free) for a connection, as JSON, for the Drive
 * "Hardware & properties" tab of non-UNAS connections. Not every backend can
 * report usage; when it cannot, the fields are simply absent and the UI hides
 * the meter. Auth is re-checked. Node runtime for Prisma and the drivers.
 */

import { userHasPermission } from "@polaris/auth";
import { requireUser } from "@/lib/session";
import { requireDriveDriver, DriveAccessError, DriveLockedError } from "@/lib/drive-authz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const user = await requireUser();
    if (!(await userHasPermission(user.id, "drive.read"))) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const connectionId = new URL(request.url).searchParams.get("c");
    if (!connectionId) return Response.json({ error: "Missing connection" }, { status: 400 });

    let driver;
    try {
        driver = await requireDriveDriver(user.id, connectionId, "", "read", { skipLock: true });
    } catch (caught) {
        if (caught instanceof DriveLockedError) return Response.json({ error: "Locked" }, { status: 423 });
        if (caught instanceof DriveAccessError) return Response.json({ error: "Forbidden" }, { status: 403 });
        throw caught;
    }
    try {
        const usage = await driver.usage();
        return Response.json({
            total: usage.total?.toString() ?? null,
            used: usage.used?.toString() ?? null,
            free: usage.free?.toString() ?? null,
            capabilities: driver.capabilities
        });
    } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Unable to read usage";
        return Response.json({ error: message }, { status: 502 });
    } finally {
        await driver.dispose();
    }
}
