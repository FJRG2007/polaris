/**
 * Goals (/tasks/goals): the outcomes the work is for.
 */

import { prisma } from "@polaris/db";
import { requirePermission, sessionCan } from "@/lib/session";
import { listGoals } from "@/lib/tasks/planning-service";
import { SpaceTree } from "@/app/(app)/tasks/space-tree";
import { listSpaceTree } from "@/lib/tasks/space-service";
import { GoalsView } from "@/app/(app)/tasks/planning-view";
import { shelfScope, type TaskActor } from "@/lib/tasks/access";

export const dynamic = "force-dynamic";

export default async function GoalsPage() {
    const user = await requirePermission("tasks.read");
    const mayManage = await sessionCan(user, "tasks.manage");
    const actor: TaskActor = { id: user.id, isAdmin: user.isAdmin };
    // A goal is a space-level plan, so only the spaces the reader holds
    // outright contribute one - a folder grant reaches work, not planning.
    const scope = await shelfScope(actor);

    const [tree, goals, spaces, lists] = await Promise.all([
        listSpaceTree(user.id, scope, user.isAdmin),
        listGoals(user.id, scope.spaceIds),
        prisma.taskSpace.findMany({
            where: { id: { in: scope.spaceIds } },
            orderBy: { order: "asc" },
            select: { id: true, name: true }
        }),
        prisma.taskList.findMany({
            where: { spaceId: { in: scope.spaceIds }, archived: false },
            orderBy: { name: "asc" },
            select: { id: true, name: true }
        })
    ]);

    return (
        <div className="flex w-full flex-col gap-6 md:flex-row">
            <SpaceTree spaces={tree} canCreate={false} canManage={mayManage} />
            <GoalsView goals={goals} spaces={spaces} lists={lists} canEdit={mayManage} />
        </div>
    );
}
