/**
 * One list (/tasks/l/<id>): the screen people live in.
 *
 * The whole list is loaded once and every view is drawn from it in the browser,
 * so switching between board and calendar costs nothing. That is affordable
 * because a list is a human-sized unit; the cross-space screens page instead.
 */

import { prisma } from "@polaris/db";
import { requirePermission } from "@/lib/session";
import { notFound, redirect } from "next/navigation";
import { listTasks } from "@/lib/tasks/task-service";
import { listViews } from "@/lib/tasks/view-service";
import { SpaceTree } from "@/app/(app)/tasks/space-tree";
import { ListScreen } from "@/app/(app)/tasks/list-view";
import { buildSpaceContext } from "@/lib/tasks/screen-context";
import { getList, listSpaceTree } from "@/lib/tasks/space-service";
import { requireList, visibleScope, type TaskActor } from "@/lib/tasks/access";

export const dynamic = "force-dynamic";

export default async function TaskListPage({ params }: { params: Promise<{ listId: string }> }) {
    const { listId } = await params;
    const user = await requirePermission("tasks.read");
    const actor: TaskActor = { id: user.id, isAdmin: user.isAdmin };

    let role;
    try {
        ({ role } = await requireList(actor, listId, "guest"));
    } catch {
        redirect("/tasks");
    }

    const list = await getList(listId);
    if (!list) notFound();

    const scope = await visibleScope(actor);
    const [tree, tasks, views, context, siblingLists] = await Promise.all([
        listSpaceTree(user.id, scope, user.isAdmin),
        listTasks({ listId }, { limit: 2000 }),
        listViews(user.id, { listId }),
        buildSpaceContext(list.spaceId, role, user.id, scope),
        // The lists work can be moved to: those in the space, narrowed to the
        // granted branch when that is all the reader reaches.
        prisma.taskList.findMany({
            where: {
                spaceId: list.spaceId,
                archived: false,
                ...(scope.partialSpaceIds.includes(list.spaceId) ? { id: { in: scope.listIds } } : {})
            },
            orderBy: { order: "asc" },
            select: { id: true, name: true, spaceId: true }
        })
    ]);

    return (
        <div className="flex w-full flex-col gap-6 md:flex-row">
            <SpaceTree spaces={tree} canCreate />
            <ListScreen
                listId={listId}
                defaultListId={listId}
                title={list.name}
                subtitle={list.folderName ? `${list.spaceName} / ${list.folderName}` : list.spaceName}
                tasks={tasks}
                savedViews={views}
                context={context}
                lists={siblingLists}
            />
        </div>
    );
}
