/**
 * Goals (/tasks/goals): the outcomes the work is for.
 */

import { prisma } from "@polaris/db";
import { requirePermission } from "@/lib/session";
import { listGoals } from "@/lib/tasks/planning-service";
import { SpaceTree } from "@/app/(app)/tasks/space-tree";
import { listSpaceTree } from "@/lib/tasks/space-service";
import { GoalsView } from "@/app/(app)/tasks/planning-view";
import { visibleSpaceIds, type TaskActor } from "@/lib/tasks/access";

export const dynamic = "force-dynamic";

export default async function GoalsPage() {
    const user = await requirePermission("tasks.read");
    const actor: TaskActor = { id: user.id, isAdmin: user.isAdmin };
    const spaceIds = await visibleSpaceIds(actor);

    const [tree, goals, spaces, lists] = await Promise.all([
        listSpaceTree(user.id, spaceIds, user.isAdmin),
        listGoals(user.id, spaceIds),
        prisma.taskSpace.findMany({
            where: { id: { in: spaceIds } },
            orderBy: { order: "asc" },
            select: { id: true, name: true }
        }),
        prisma.taskList.findMany({
            where: { spaceId: { in: spaceIds }, archived: false },
            orderBy: { name: "asc" },
            select: { id: true, name: true }
        })
    ]);

    return (
        <div className="flex w-full flex-col gap-6 md:flex-row">
            <SpaceTree spaces={tree} canCreate={false} />
            <GoalsView goals={goals} spaces={spaces} lists={lists} />
        </div>
    );
}
