/**
 * Opening one item by its path, without knowing yet what it is.
 *
 * A share names a path. Whether that path is a folder or a file decides where
 * the person should land - the browser, or the file itself - and the only thing
 * that knows is the storage. Asking it while a list of shared items is being
 * drawn would mean one round trip per row against a NAS before anything appears,
 * so it is asked here instead: once, when somebody actually opens one.
 *
 * It also settles a case the browser cannot handle on its own. Somebody given a
 * single file may read that file and nothing else - not even the names of the
 * things beside it - so there is no listing to show them. The file is what they
 * were given, so the file is what they get.
 */

import { redirect } from "next/navigation";
import { normalizeRelPath } from "@polaris/core";
import { requireUser, sessionCan } from "@/lib/session";
import { requireDriveDriver, DriveAccessError, DriveLockedError } from "@/lib/drive-authz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const user = await requireUser();
    if (!(await sessionCan(user, "drive.read"))) {
        return new Response("Forbidden", { status: 403 });
    }

    const url = new URL(request.url);
    const connectionId = url.searchParams.get("c");
    if (!connectionId) return new Response("Missing connection", { status: 400 });

    let path: string;
    try {
        path = normalizeRelPath(url.searchParams.get("p") ?? "");
    } catch {
        return new Response("Invalid path", { status: 400 });
    }

    const browse = `/drive?c=${encodeURIComponent(connectionId)}&p=${encodeURIComponent(path)}`;

    let driver;
    try {
        driver = await requireDriveDriver(user.id, connectionId, path, "read");
    } catch (caught) {
        // A locked path is a password prompt, which the browser already draws;
        // send them there rather than answering with a bare 423 nobody can act on.
        if (caught instanceof DriveLockedError) redirect(browse);
        if (caught instanceof DriveAccessError) return new Response("Forbidden", { status: 403 });
        throw caught;
    }

    let isDir: boolean;
    try {
        isDir = (await driver.stat(path)).kind === "dir";
    } catch {
        // It is gone, or the storage is not answering. The browser says which of
        // those far better than a status code here would.
        redirect(browse);
    } finally {
        await driver.dispose().catch(() => undefined);
    }

    redirect(
        isDir
            ? browse
            : `/api/drive/download?c=${encodeURIComponent(connectionId)}&p=${encodeURIComponent(path)}&disposition=inline`
    );
}
