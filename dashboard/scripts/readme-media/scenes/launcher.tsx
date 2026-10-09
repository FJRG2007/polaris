/** The app launcher, opened over the Tasks board with something waiting. */

import { TaskBoard } from "./tasks";
import { label, openMenu } from "../runtime/interact";
import { defineScene } from "../runtime/scene";
import { TASK_LIST_ID } from "../fixtures/tasks";
import { launcherUnread, launcherWaiting } from "../fixtures/launcher";

export const launcher = defineScene({
    id: "launcher",
    path: `/tasks/l/${TASK_LIST_ID}`,
    api: (ctx) => ({ "GET /api/launcher/waiting": () => launcherWaiting(ctx) }),
    render: (ctx) => <TaskBoard ctx={ctx} unread={launcherUnread(ctx)} />,
    prepare: (ctx) => openMenu(label(ctx.locale, "nav.labels.Tasks"))
});
