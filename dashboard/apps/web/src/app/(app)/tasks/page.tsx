/**
 * Tasks home (/tasks). What is assigned to this person across every space they
 * can reach, with the spaces sidebar beside it.
 *
 * A first visit has no spaces at all, so the empty state here is the one that
 * has to teach the hierarchy: a space holds lists, a list holds tasks.
 */

import { HomeView } from "./home-view";
import { SpaceTree } from "./space-tree";
import { requirePermission } from "@/lib/session";
import { listTasks } from "@/lib/tasks/task-service";
import { resolveSpaceRole } from "@/lib/tasks/access";
import type { SpaceContext } from "@/lib/tasks/facts";
import { runningTimer } from "@/lib/tasks/time-service";
import { listSpaceTree } from "@/lib/tasks/space-service";
import { myWorkCounts } from "@/lib/tasks/report-service";
import { buildSpaceContext } from "@/lib/tasks/screen-context";
import { visibleSpaceIds, type TaskActor } from "@/lib/tasks/access";

export const dynamic = "force-dynamic";

export default async function TasksHomePage() {
    const user = await requirePermission("tasks.read");
    const actor: TaskActor = { id: user.id, isAdmin: user.isAdmin };
    const spaceIds = await visibleSpaceIds(actor);

    const [tree, tasks, counts, timer] = await Promise.all([
        listSpaceTree(user.id, spaceIds, user.isAdmin),
        listTasks({ spaceIds, assigneeId: user.id }, { limit: 500 }),
        myWorkCounts(user.id, spaceIds),
        runningTimer(user.id)
    ]);

    // Only the spaces the listed work actually comes from: building a context
    // for every space would load vocabulary nothing on this screen reads.
    const involved = [...new Set(tasks.map((task) => task.spaceId))];
    const contexts: Record<string, SpaceContext> = {};
    for (const spaceId of involved) {
        const role = await resolveSpaceRole(actor, spaceId);
        if (role) contexts[spaceId] = await buildSpaceContext(spaceId, role, user.id);
    }

    return (
        <div className="flex w-full flex-col gap-6 md:flex-row">
            <SpaceTree spaces={tree} canCreate />
            <HomeView tasks={tasks} counts={counts} timer={timer} contexts={contexts} />
        </div>
    );
}
