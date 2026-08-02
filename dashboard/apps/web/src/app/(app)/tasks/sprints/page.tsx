/**
 * Sprints (/tasks/sprints) across every space the reader can see.
 */

import { prisma } from "@polaris/db";
import { requirePermission } from "@/lib/session";
import type { BurndownPoint } from "@polaris/core";
import { SpaceTree } from "@/app/(app)/tasks/space-tree";
import { listSpaceTree } from "@/lib/tasks/space-service";
import { SprintsView } from "@/app/(app)/tasks/planning-view";
import { visibleScope, type TaskActor } from "@/lib/tasks/access";
import { listSprints, sprintBurndown } from "@/lib/tasks/planning-service";

export const dynamic = "force-dynamic";

export default async function SprintsPage() {
    const user = await requirePermission("tasks.read");
    const actor: TaskActor = { id: user.id, isAdmin: user.isAdmin };
    // Sprints belong to a space, not to a branch of one, so they are listed
    // only for the spaces the reader holds outright.
    const scope = await visibleScope(actor);

    const [tree, spaces] = await Promise.all([
        listSpaceTree(user.id, scope, user.isAdmin),
        prisma.taskSpace.findMany({
            where: { id: { in: scope.spaceIds } },
            orderBy: { order: "asc" },
            select: { id: true, name: true }
        })
    ]);

    const perSpace = await Promise.all(
        spaces.map(async (space) => {
            const sprints = await listSprints(space.id);
            return sprints.map((sprint) => ({ ...sprint, spaceId: space.id, spaceName: space.name }));
        })
    );
    const sprints = perSpace.flat();

    const burndowns: Record<string, BurndownPoint[]> = {};
    for (const sprint of sprints) {
        // Only sprints that are running or finished have a line worth drawing; a
        // planned one is a straight edge nobody learns anything from.
        if (sprint.status !== "planned") burndowns[sprint.id] = await sprintBurndown(sprint.id);
    }

    return (
        <div className="flex w-full flex-col gap-6 md:flex-row">
            <SpaceTree spaces={tree} canCreate={false} />
            <SprintsView sprints={sprints} spaces={spaces} burndowns={burndowns} />
        </div>
    );
}
