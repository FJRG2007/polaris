/** Tasks: a list's board mid-sprint, the screen a team lives in. */

import { Chrome } from "../runtime/chrome";
import { defineScene } from "../runtime/scene";
import { PlainNames } from "@/components/person-name";
import { SpaceTree } from "@/app/(app)/tasks/space-tree";
import { ListScreen } from "@/app/(app)/tasks/list-view";
import {
    TASK_LIST_ID,
    taskDetail,
    listName,
    spaceName,
    spaceTree,
    taskContext,
    taskRows
} from "../fixtures/tasks";
import type { SceneContext } from "../runtime/scene";

/** The page `/tasks/l/[listId]` draws, with what it would have read. */
export function TaskBoard({
    ctx,
    openTask = null,
    unread
}: {
    ctx: SceneContext;
    openTask?: string | null;
    /** What the badges above the board count, when the scene is about them. */
    unread?: { chat?: number; mail?: number };
}) {
    return (
        <Chrome unread={unread}>
            <PlainNames>
                <div className="flex w-full flex-col gap-6 md:flex-row">
                    <SpaceTree spaces={spaceTree(ctx)} canCreate canManage />
                    <ListScreen
                        listId={TASK_LIST_ID}
                        defaultListId={TASK_LIST_ID}
                        title={listName(ctx)}
                        subtitle={spaceName(ctx)}
                        tasks={taskRows(ctx)}
                        savedViews={[]}
                        context={taskContext(ctx)}
                        lists={[
                            {
                                id: TASK_LIST_ID,
                                name: listName(ctx),
                                spaceId: taskContext(ctx).spaceId
                            }
                        ]}
                        initialTaskId={openTask}
                    />
                </div>
            </PlainNames>
        </Chrome>
    );
}

export const tasks = defineScene({
    id: "tasks",
    path: `/tasks/l/${TASK_LIST_ID}`,
    params: { listId: TASK_LIST_ID },
    render: (ctx) => <TaskBoard ctx={ctx} />
});

export const taskPanel = defineScene({
    id: "task-panel",
    path: `/tasks/l/${TASK_LIST_ID}`,
    params: { listId: TASK_LIST_ID },
    actions: (ctx) => ({ getTaskDetailAction: () => ({ detail: taskDetail(ctx) }) }),
    render: (ctx) => <TaskBoard ctx={ctx} openTask={taskRows(ctx)[0]!.id} />
});
