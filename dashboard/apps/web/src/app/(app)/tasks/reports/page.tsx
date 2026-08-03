/**
 * Reporting (/tasks/reports): where the work actually is.
 *
 * Every number here is an aggregate the database computed, so the page costs the
 * same whether the workspace holds fifty tasks or fifty thousand.
 */

import { requirePermission } from "@/lib/session";
import { timeByPerson } from "@/lib/tasks/time-service";
import { SpaceTree } from "@/app/(app)/tasks/space-tree";
import { buildReport } from "@/lib/tasks/report-service";
import { listSpaceTree } from "@/lib/tasks/space-service";
import { ReportsView } from "@/app/(app)/tasks/reports-view";
import { visibleScope, type TaskActor } from "@/lib/tasks/access";
import { addDays, startOfWeek, weekStartIndex } from "@polaris/core";
import { resolveDisplayPreferencesFor } from "@/lib/display-prefs-service";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
    const user = await requirePermission("tasks.read");
    const actor: TaskActor = { id: user.id, isAdmin: user.isAdmin };
    const scope = await visibleScope(actor);

    const now = new Date();
    const weekStartsOn = weekStartIndex((await resolveDisplayPreferencesFor(user.id)).weekStart);
    const weekStart = startOfWeek(now, weekStartsOn);

    const [tree, report, byPerson] = await Promise.all([
        listSpaceTree(user.id, scope, user.isAdmin),
        buildReport(scope, now, weekStartsOn),
        timeByPerson(scope, weekStart, addDays(weekStart, 7))
    ]);

    return (
        <div className="flex w-full flex-col gap-6 md:flex-row">
            <SpaceTree spaces={tree} canCreate={false} />
            <ReportsView report={report} timeByPerson={byPerson} />
        </div>
    );
}
