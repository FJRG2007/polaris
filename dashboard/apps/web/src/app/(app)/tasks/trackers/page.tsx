/**
 * Connected trackers (/tasks/trackers): Linear and Jira are connected from
 * Connected accounts now, beside every other account. The address stays, for
 * the Tasks menu and anybody who saved it, and sends them there and back.
 */

import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { connectionsHref, TASK_TRACKERS_SECTION } from "@/lib/connections/hub-href";

export const dynamic = "force-dynamic";

export default async function TaskTrackersPage() {
    await requirePermission("tasks.manage");
    redirect(connectionsHref(TASK_TRACKERS_SECTION, "/tasks"));
}
