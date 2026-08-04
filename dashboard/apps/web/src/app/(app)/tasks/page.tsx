/**
 * Tasks home (/tasks). What is assigned to this person across every space they
 * can reach, with the spaces sidebar beside it.
 *
 * A first visit has no spaces at all, so the empty state here is the one that
 * has to teach the hierarchy: a space holds lists, a list holds tasks.
 */

import { prisma } from "@polaris/db";
import { HomeView } from "./home-view";
import { SpaceTree } from "./space-tree";
import { requirePermission } from "@/lib/session";
import { listTasks } from "@/lib/tasks/task-service";
import type { SpaceContext } from "@/lib/tasks/facts";
import { runningTimer } from "@/lib/tasks/time-service";
import { listSpaceTree } from "@/lib/tasks/space-service";
import { myWorkCounts } from "@/lib/tasks/report-service";
import { buildSpaceContext } from "@/lib/tasks/screen-context";
import { scopedSpaceRole, visibleScope, type TaskActor } from "@/lib/tasks/access";

export const dynamic = "force-dynamic";

export default async function TasksHomePage() {
    const user = await requirePermission("tasks.read");
    const actor: TaskActor = { id: user.id, isAdmin: user.isAdmin };
    const scope = await visibleScope(actor);

    const [tree, tasks, counts, timer, lists] = await Promise.all([
        listSpaceTree(user.id, scope, user.isAdmin),
        // Only what is still to do. Ticking a task off is how somebody clears
        // this screen, so leaving it on the list makes the gesture do nothing -
        // and the counts above already left it out, so the two disagreed.
        listTasks(
            { spaceIds: scope.spaceIds, listIds: scope.listIds, assigneeId: user.id },
            { limit: 500, openOnly: true }
        ),
        myWorkCounts(user.id, scope),
        runningTimer(user.id),
        // Where a task can be moved from here. The space rides along because
        // work only moves between lists of its own.
        prisma.taskList.findMany({
            where: {
                archived: false,
                OR: [{ spaceId: { in: scope.spaceIds } }, { id: { in: scope.listIds } }]
            },
            orderBy: { name: "asc" },
            select: { id: true, name: true, spaceId: true }
        })
    ]);

    // Only the spaces the listed work actually comes from: building a context
    // for every space would load vocabulary nothing on this screen reads.
    const involved = [...new Set(tasks.map((task) => task.spaceId))];
    const contexts: Record<string, SpaceContext> = {};
    for (const spaceId of involved) {
        const role = await scopedSpaceRole(actor, scope, spaceId);
        if (role) contexts[spaceId] = await buildSpaceContext(spaceId, role, user.id, scope);
    }

    return (
        <div className="flex w-full flex-col gap-6 md:flex-row">
            <SpaceTree spaces={tree} canCreate />
            <HomeView tasks={tasks} counts={counts} timer={timer} contexts={contexts} lists={lists} />
        </div>
    );
}
