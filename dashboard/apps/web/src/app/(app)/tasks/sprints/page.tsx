/**
 * Sprints (/tasks/sprints) across every space the reader can see.
 */

import { prisma } from "@polaris/db";
import { requirePermission, sessionCan } from "@/lib/session";
import type { BurndownPoint } from "@polaris/core";
import { SpaceTree } from "@/app/(app)/tasks/space-tree";
import { listSpaceTree } from "@/lib/tasks/space-service";
import { SprintsView } from "@/app/(app)/tasks/planning-view";
import { shelfScope, type TaskActor } from "@/lib/tasks/access";
import { listSprints, sprintBurndown } from "@/lib/tasks/planning-service";

export const dynamic = "force-dynamic";

export default async function SprintsPage() {
    const user = await requirePermission("tasks.read");
    const mayManage = await sessionCan(user, "tasks.manage");
    const actor: TaskActor = { id: user.id, isAdmin: user.isAdmin };
    const scope = await shelfScope(actor);
    // A space-wide sprint needs the space. A sprint planning one folder is
    // reached by whoever was granted that folder, and by nobody beside them.
    const grantedFolderIds = Object.keys(scope.folderRoles);

    const [tree, spaces, sprints] = await Promise.all([
        listSpaceTree(user.id, scope, user.isAdmin),
        prisma.taskSpace.findMany({
            where: { id: { in: [...scope.spaceIds, ...scope.partialSpaceIds] } },
            orderBy: { order: "asc" },
            select: { id: true, name: true }
        }),
        listSprints({ spaceIds: scope.spaceIds, folderIds: grantedFolderIds })
    ]);

    const spaceNames = new Map(spaces.map((space) => [space.id, space.name]));
    const named = sprints.map((sprint) => ({ ...sprint, spaceName: spaceNames.get(sprint.spaceId) ?? "" }));

    const burndowns: Record<string, BurndownPoint[]> = {};
    for (const sprint of named) {
        // Only sprints that are running or finished have a line worth drawing; a
        // planned one is a straight edge nobody learns anything from.
        if (sprint.status !== "planned") burndowns[sprint.id] = await sprintBurndown(sprint.id);
    }

    return (
        <div className="flex w-full flex-col gap-6 md:flex-row">
            <SpaceTree spaces={tree} canCreate={false} canManage={mayManage} />
            <SprintsView
                sprints={named}
                spaces={spaces.filter((space) => scope.spaceIds.includes(space.id))}
                burndowns={burndowns}
                canEdit={mayManage}
            />
        </div>
    );
}
