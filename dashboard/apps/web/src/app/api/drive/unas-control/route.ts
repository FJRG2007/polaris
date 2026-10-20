/**
 * The UNAS controls as JSON, for the Drive overview: the native fan profile and
 * the console's backup tasks. Each is read on its own, so a console without
 * backups still reports its fans. Node runtime.
 */

import { sessionCan } from "@/lib/session";
import { apiUser } from "@/lib/api-session";
import { getUnasTarget } from "@/lib/storage-service";
import { readerWords } from "@/lib/i18n/reader-words";
import {
    backupFailed,
    backupOverdue,
    listBackupTasks,
    readFanProfile
} from "@/lib/unifi-unas-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    if (!(await sessionCan(user, "drive.read"))) {
        return Response.json({ error: (await readerWords("api"))("errors.forbidden") }, { status: 403 });
    }

    const connectionId = new URL(request.url).searchParams.get("c");
    if (!connectionId) return Response.json({ error: (await readerWords("api"))("errors.missingConnection") }, { status: 400 });

    try {
        const target = await getUnasTarget(connectionId, user.id);
        const [fan, tasks] = await Promise.allSettled([readFanProfile(target), listBackupTasks(target)]);
        if (fan.status === "rejected" && tasks.status === "rejected") throw fan.reason;
        const now = new Date();
        return Response.json({
            fanProfile: fan.status === "fulfilled" ? fan.value : null,
            tasks:
                tasks.status === "fulfilled"
                    ? tasks.value.map((task) => ({
                          ...task,
                          failed: backupFailed(task),
                          overdue: backupOverdue(task, now)
                      }))
                    : null
        });
    } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Unable to reach the UNAS console";
        return Response.json({ error: message }, { status: 502 });
    }
}
