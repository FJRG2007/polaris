/**
 * Everything (/tasks/everything): one view across every space the reader can
 * reach.
 *
 * The vocabulary shown here is the union of every space's - a workspace with two
 * spaces has two sets of statuses, and hiding one of them would silently drop
 * its tasks off the board. Grouping by list is therefore the default: it is the
 * only grouping that stays meaningful when the statuses do not line up.
 */

import { prisma } from "@polaris/db";
import { requirePermission } from "@/lib/session";
import * as spaces from "@/lib/tasks/space-service";
import { listTasks } from "@/lib/tasks/task-service";
import type { SpaceContext } from "@/lib/tasks/facts";
import { ListScreen } from "@/app/(app)/tasks/list-view";
import { SpaceTree } from "@/app/(app)/tasks/space-tree";
import { scopeSpaceIds, shelfScope, type TaskActor } from "@/lib/tasks/access";

export const dynamic = "force-dynamic";

export default async function EverythingPage() {
    const user = await requirePermission("tasks.read");
    const actor: TaskActor = { id: user.id, isAdmin: user.isAdmin };
    const scope = await shelfScope(actor);
    // The vocabulary (statuses, tags, fields) is drawn from every space the
    // reader touches, including one they only reach through a folder - without
    // its statuses the tasks from that branch would have no column to sit in.
    // The work itself stays narrowed to the branch.
    const spaceIds = scopeSpaceIds(scope);

    const [tree, tasks, statuses, tags, fields, lists, people] = await Promise.all([
        spaces.listSpaceTree(user.id, scope, user.isAdmin),
        listTasks({ spaceIds: scope.spaceIds, listIds: scope.listIds }, { limit: 2000 }),
        prisma.taskStatus.findMany({
            where: { spaceId: { in: spaceIds } },
            orderBy: { order: "asc" },
            select: { id: true, name: true, type: true, color: true, order: true }
        }),
        prisma.taskTag.findMany({
            where: { spaceId: { in: spaceIds } },
            orderBy: { name: "asc" },
            select: { id: true, name: true, color: true }
        }),
        prisma.taskCustomField.findMany({
            where: { spaceId: { in: spaceIds } },
            orderBy: { order: "asc" },
            select: { id: true, name: true, type: true, config: true, required: true, showOnCard: true }
        }),
        prisma.taskList.findMany({
            where: {
                archived: false,
                OR: [{ spaceId: { in: scope.spaceIds } }, { id: { in: scope.listIds } }]
            },
            orderBy: { name: "asc" },
            // The space comes with it: work only moves between lists of its own
            // space, so a destination has to say which one it belongs to.
            select: { id: true, name: true, spaceId: true }
        }),
        // The people on the spaces in reach, not the instance's whole directory:
        // a picker here should offer who can actually be given this work.
        prisma.user.findMany({
            where: {
                OR: [
                    { taskSpaces: { some: { id: { in: spaceIds } } } },
                    { taskSpaceMemberships: { some: { spaceId: { in: spaceIds } } } },
                    { taskFolderMemberships: { some: { folder: { spaceId: { in: spaceIds } } } } }
                ]
            },
            select: { id: true, name: true, image: true }
        })
    ]);

    const context: SpaceContext = {
        // No single space owns this screen; writes still resolve the real space
        // from the task they touch, so this id is only ever used for display.
        spaceId: "",
        statuses: statuses.map((status) => ({ ...status, type: status.type as never })),
        tags,
        fields: fields.map((field) => ({
            id: field.id,
            name: field.name,
            type: field.type as never,
            config: {},
            required: field.required,
            showOnCard: field.showOnCard
        })),
        people,
        canEdit: true,
        canModerate: user.isAdmin,
        currentUserId: user.id,
        siblings: tasks
    };

    return (
        <div className="flex w-full flex-col gap-6 md:flex-row">
            <SpaceTree spaces={tree} canCreate />
            <ListScreen
                listId={null}
                defaultListId={null}
                title="Everything"
                subtitle="Every task across every space you can see"
                tasks={tasks}
                savedViews={[]}
                context={context}
                lists={lists}
            />
        </div>
    );
}
