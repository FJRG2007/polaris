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
import { visibleSpaceIds, type TaskActor } from "@/lib/tasks/access";

export const dynamic = "force-dynamic";

export default async function EverythingPage() {
    const user = await requirePermission("tasks.read");
    const actor: TaskActor = { id: user.id, isAdmin: user.isAdmin };
    const spaceIds = await visibleSpaceIds(actor);

    const [tree, tasks, statuses, tags, fields, lists, people] = await Promise.all([
        spaces.listSpaceTree(user.id, spaceIds, user.isAdmin),
        listTasks({ spaceIds }, { limit: 2000 }),
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
            where: { spaceId: { in: spaceIds }, archived: false },
            orderBy: { name: "asc" },
            select: { id: true, name: true }
        }),
        prisma.user.findMany({ select: { id: true, name: true, image: true } })
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
