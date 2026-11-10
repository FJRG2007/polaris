/**
 * What every Telemetry screen needs before it draws: that the reader may be
 * here, who they are, and whether "Create task" is something the server will
 * do for them - asked here with the same checks the actions make, so the
 * button is only offered when it works.
 */

import { requireUser, sessionCan } from "@/lib/session";
import { isAppInstalled } from "@/lib/apps/install-presence";
import { requireTelemetryReader } from "@/lib/telemetry/reader";
import { requireInstalledApp } from "@/lib/apps/require-installed";
import { ISSUE_SORTS, DEFAULT_QUERY, type IssueSort } from "@/lib/telemetry/issue-query";

export async function telemetryScreen(): Promise<{
    manages: boolean;
    viewer: { id: string; name: string };
    mayTask: boolean;
}> {
    const { manages } = await requireTelemetryReader();
    const user = await requireUser();
    await requireInstalledApp("telemetry", user);
    const [tasks, installed] = await Promise.all([
        sessionCan(user, "tasks.manage"),
        isAppInstalled("tasks")
    ]);
    return { manages, viewer: { id: user.id, name: user.name }, mayTask: tasks && installed };
}

/** The search and order a URL carries, or the defaults. */
export function searchFrom(params: { query?: string; sort?: string }): {
    query: string;
    sort: IssueSort;
} {
    const query = typeof params.query === "string" ? params.query.slice(0, 500) : DEFAULT_QUERY;
    const sort = (ISSUE_SORTS as readonly string[]).includes(params.sort ?? "")
        ? (params.sort as IssueSort)
        : "lastSeen";
    return { query, sort };
}
