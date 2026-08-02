/**
 * A task by its own URL (/tasks/t/<id>).
 *
 * This is what a notification, a comment link or a pasted reference opens. It
 * renders the task's list with the panel already open, so arriving from outside
 * lands you in the same place as clicking the card would have - with the rest of
 * the work visible behind it rather than on a page with no context.
 */

import { prisma } from "@polaris/db";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { listTasks } from "@/lib/tasks/task-service";
import { listViews } from "@/lib/tasks/view-service";
import { ListScreen } from "@/app/(app)/tasks/list-view";
import { SpaceTree } from "@/app/(app)/tasks/space-tree";
import { buildSpaceContext } from "@/lib/tasks/screen-context";
import { getList, listSpaceTree } from "@/lib/tasks/space-service";
import { requireTask, visibleScope, type TaskActor } from "@/lib/tasks/access";

export const dynamic = "force-dynamic";

export default async function TaskPermalinkPage({ params }: { params: Promise<{ taskId: string }> }) {
    const { taskId } = await params;
    const user = await requirePermission("tasks.read");
    const actor: TaskActor = { id: user.id, isAdmin: user.isAdmin };

    let resolved;
    try {
        resolved = await requireTask(actor, taskId, "guest");
    } catch {
        redirect("/tasks");
    }

    const list = await getList(resolved.listId);
    if (!list) redirect("/tasks");

    const scope = await visibleScope(actor);
    const [tree, tasks, views, context, siblingLists] = await Promise.all([
        listSpaceTree(user.id, scope, user.isAdmin),
        listTasks({ listId: resolved.listId }, { limit: 2000 }),
        listViews(user.id, { listId: resolved.listId }),
        buildSpaceContext(resolved.spaceId, resolved.role, user.id, scope),
        prisma.taskList.findMany({
            where: {
                spaceId: resolved.spaceId,
                archived: false,
                ...(scope.partialSpaceIds.includes(resolved.spaceId) ? { id: { in: scope.listIds } } : {})
            },
            orderBy: { order: "asc" },
            select: { id: true, name: true }
        })
    ]);

    return (
        <div className="flex w-full flex-col gap-6 md:flex-row">
            <SpaceTree spaces={tree} canCreate />
            <ListScreen
                listId={resolved.listId}
                defaultListId={resolved.listId}
                initialTaskId={taskId}
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
