/**
 * Timesheets (/tasks/time): one person's week, task by task.
 *
 * The week is the unit because that is what gets approved and invoiced. Anchor
 * moves in whole weeks through the query string, so a particular week is a link
 * rather than a click path.
 */

import { requirePermission } from "@/lib/session";
import { addDays, startOfWeek } from "@polaris/core";
import { SpaceTree } from "@/app/(app)/tasks/space-tree";
import { listSpaceTree } from "@/lib/tasks/space-service";
import { TimesheetView } from "@/app/(app)/tasks/timesheet-view";
import { visibleSpaceIds, type TaskActor } from "@/lib/tasks/access";
import { runningTimer, weeklyTimesheet } from "@/lib/tasks/time-service";

export const dynamic = "force-dynamic";

export default async function TimesheetPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
    const { week } = await searchParams;
    const user = await requirePermission("tasks.read");
    const actor: TaskActor = { id: user.id, isAdmin: user.isAdmin };
    const spaceIds = await visibleSpaceIds(actor);

    const offset = Number(week ?? "0");
    const anchor = addDays(startOfWeek(new Date()), Number.isFinite(offset) ? offset * 7 : 0);

    const [tree, sheet, timer] = await Promise.all([
        listSpaceTree(user.id, spaceIds, user.isAdmin),
        weeklyTimesheet(user.id, anchor, spaceIds),
        runningTimer(user.id)
    ]);

    return (
        <div className="flex w-full flex-col gap-6 md:flex-row">
            <SpaceTree spaces={tree} canCreate={false} />
            <TimesheetView sheet={sheet} timer={timer} weekOffset={Number.isFinite(offset) ? offset : 0} />
        </div>
    );
}
