/**
 * Reporting (/tasks/reports): where the work actually is.
 *
 * Every number here is an aggregate the database computed, so the page costs the
 * same whether the workspace holds fifty tasks or fifty thousand.
 */

import { requirePermission } from "@/lib/session";
import { addDays, startOfWeek } from "@polaris/core";
import { timeByPerson } from "@/lib/tasks/time-service";
import { SpaceTree } from "@/app/(app)/tasks/space-tree";
import { buildReport } from "@/lib/tasks/report-service";
import { listSpaceTree } from "@/lib/tasks/space-service";
import { ReportsView } from "@/app/(app)/tasks/reports-view";
import { visibleSpaceIds, type TaskActor } from "@/lib/tasks/access";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
    const user = await requirePermission("tasks.read");
    const actor: TaskActor = { id: user.id, isAdmin: user.isAdmin };
    const spaceIds = await visibleSpaceIds(actor);

    const now = new Date();
    const weekStart = startOfWeek(now);

    const [tree, report, byPerson] = await Promise.all([
        listSpaceTree(user.id, spaceIds, user.isAdmin),
        buildReport(spaceIds, now),
        timeByPerson(spaceIds, weekStart, addDays(weekStart, 7))
    ]);

    return (
        <div className="flex w-full flex-col gap-6 md:flex-row">
            <SpaceTree spaces={tree} canCreate={false} />
            <ReportsView report={report} timeByPerson={byPerson} />
        </div>
    );
}
