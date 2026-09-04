/**
 * Where the room in one Drive location went: the heaviest folders, the biggest
 * files, and what the formats add up to.
 *
 * Its own route rather than part of `insights` because it answers a different
 * question with a different budget. `insights` fills in a listing that is
 * already on screen and must not keep anybody waiting; this is the screen, and
 * somebody who opened it is willing to wait a few seconds for it.
 *
 * The same gate as every other read: the session, `drive.read`, the access rules
 * for the path, and the locked folders left out of the walk exactly as they are
 * left out of a listing. Node runtime because the drivers need it.
 */

import { normalizeRelPath } from "@polaris/core";
import { apiUser } from "@/lib/api-session";
import { listLocks } from "@/lib/access-lock-service";
import { driveBreakdown } from "@/lib/drive-breakdown";
import { sessionCan } from "@/lib/session";
import { getDriverForConnection, SmbShareRequiredError } from "@/lib/storage-service";
import { authorizeDrive, DriveAccessError, DriveLockedError } from "@/lib/drive-authz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    if (!(await sessionCan(user, "drive.read"))) {
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

    try {
        await authorizeDrive(user.id, connectionId, path, "read");
    } catch (caught) {
        if (caught instanceof DriveLockedError) return Response.json({ locked: true });
        if (caught instanceof DriveAccessError) return Response.json({ error: "Forbidden" }, { status: 403 });
        throw caught;
    }

    let driver;
    try {
        driver = await getDriverForConnection(connectionId);
    } catch (caught) {
        if (caught instanceof SmbShareRequiredError) return Response.json({ needsSmbShare: true });
        console.error("drive: breakdown connect failed", caught);
        return Response.json({ error: "Could not connect to this location" }, { status: 502 });
    }

    try {
        const gated = new Set((await listLocks(connectionId)).map((lock) => lock.path).filter(Boolean));
        return Response.json(await driveBreakdown(driver, path, { skip: gated }));
    } catch (caught) {
        console.error("drive: breakdown failed", caught);
        return Response.json({ error: "Could not measure this location" }, { status: 502 });
    } finally {
        await driver.dispose();
    }
}
