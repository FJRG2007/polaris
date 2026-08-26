/**
 * Everything (/tasks/everything): one view across every space the reader can
 * reach.
 *
 * The vocabulary shown here is the union of every space's - a workspace with two
 * spaces has two sets of statuses, and hiding one of them would silently drop
 * its tasks off the board. Grouping by list is therefore the default: it is the
 * only grouping that stays meaningful when the statuses do not line up.
 *
 * `?assignee=` opens it narrowed to one person, which is where picking somebody
 * out of the global search lands. It is the filter this screen already applies,
 * not a second kind of query, so the reader can widen or clear it like any other.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { requirePermission, sessionCan } from "@/lib/session";
import * as spaces from "@/lib/tasks/space-service";
import { listTasks } from "@/lib/tasks/task-service";
import type { SpaceContext } from "@/lib/tasks/facts";
import { ListScreen } from "@/app/(app)/tasks/list-view";
import { SpaceTree } from "@/app/(app)/tasks/space-tree";
import { scopeSpaceIds, shelfScope, type TaskActor } from "@/lib/tasks/access";

export const dynamic = "force-dynamic";

/** Anything else in the address is somebody's hand-edited URL, and is ignored. */
const assigneeParam = z.string().uuid();

export default async function EverythingPage({
    searchParams
}: {
    searchParams: Promise<{ assignee?: string }>;
}) {
    const user = await requirePermission("tasks.read");
    // Seeing every space's work does not mean being allowed to change any of it.
    const mayManage = await sessionCan(user, "tasks.manage");
    const wanted = assigneeParam.safeParse((await searchParams).assignee);
    const assigneeId = wanted.success ? wanted.data : null;
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

    // Whoever already holds work here counts as somebody this screen knows,
    // even if they are on no space: their name has to be readable in a filter
    // chip and beside their tasks, and it is already on the rows above.
    const roster = [...people];
    for (const task of tasks) {
        for (const person of task.assignees) {
            if (!roster.some((known) => known.id === person.id)) roster.push(person);
        }
    }

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
        people: roster,
        canEdit: mayManage,
        canModerate: mayManage && user.isAdmin,
        currentUserId: user.id,
        siblings: tasks
    };

    // The name comes from the roster this screen already has, so saying whose
    // work this is costs nothing. An id that matches nobody on it still filters,
    // and the heading stays general rather than naming an account whose name
    // this reader has not been shown anywhere else.
    const assignee = assigneeId ? roster.find((person) => person.id === assigneeId) : null;
    const initialFilter: core.TaskFilter | undefined = assigneeId
        ? { match: "all", conditions: [{ field: "assignee", operator: "anyOf", values: [assigneeId] }] }
        : undefined;

    return (
        <div className="flex w-full flex-col gap-6 md:flex-row">
            <SpaceTree spaces={tree} canCreate canManage={mayManage} />
            <ListScreen
                // The filter is this screen's opening state, not a prop it
                // watches, and moving from one person to another is a soft
                // navigation - without a key React would keep the first
                // person's filter under the second person's heading.
                key={assigneeId ?? "everything"}
                listId={null}
                defaultListId={null}
                title="Everything"
                subtitle={
                    assignee
                        ? `Tasks assigned to ${assignee.name}`
                        : assigneeId
                          ? "Tasks assigned to one person"
                          : "Every task across every space you can see"
                }
                tasks={tasks}
                savedViews={[]}
                context={context}
                lists={lists}
                initialFilter={initialFilter}
            />
        </div>
    );
}
