/** Tasks: a list's board mid-sprint, the screen a team lives in. */

import { once } from "../runtime/interact";
import { tourScene } from "../runtime/tour";
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

const tasksStill = defineScene({
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

/**
 * On a phone the task's fields and its activity share one scrolling column,
 * and the activity brings its latest comment into view, which leaves the
 * column at its end. Start it at the top, where the task's name and status are.
 */
async function panelFromTop() {
    if (window.matchMedia("(min-width: 768px)").matches) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
    await once(() => {
        const dialog = document.querySelector("[role='dialog']");
        if (!dialog) throw new Error("the task did not open");
        for (const element of dialog.querySelectorAll<HTMLElement>("*"))
            if (element.scrollTop > 0) element.scrollTop = 0;
    });
}

/** The board, then a task opened beside it. */
export const tasks = tourScene(
    [tasksStill, taskPanel],
    [{ hold: 1600 }, { view: 1, run: () => panelFromTop(), hold: 3400 }]
);
