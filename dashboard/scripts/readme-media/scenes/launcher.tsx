/**
 * The app launcher, opened over the Tasks board with something waiting: the
 * chats are marked read from their tile, then everything else from the menu's
 * foot, without opening either app.
 */

import { TaskBoard } from "./tasks";
import { label, openMenu } from "../runtime/interact";
import { defineScene } from "../runtime/scene";
import { TASK_LIST_ID } from "../fixtures/tasks";
import { launcherUnread, launcherWaiting } from "../fixtures/launcher";
import type { LauncherWaiting } from "@/lib/launcher-waiting";

/** What has been marked read so far in this picture, which is what the server
 *  would have stored: the menu asks again after a mark and must hear it. */
const marked = new Set<string>();

function remaining(waiting: LauncherWaiting): LauncherWaiting {
    return { groups: waiting.groups.filter((group) => !marked.has(group.app)) };
}

/** The small "mark read" on the corner of the `app` tile. It shows on hover or
 *  focus, so it is focused first: that is the frame a hand on the tile sees. */
function tileMark(app: string): HTMLElement {
    const found = document.querySelector<HTMLElement>(`[data-launcher-tile-action="${app}"]`);
    if (!found) throw new Error(`no mark on the ${app} tile`);
    return found;
}

function footMark(text: string): HTMLElement {
    const found = document.querySelector<HTMLElement>(`[aria-label="${text}"]`);
    if (!found) throw new Error(`nothing reads "${text}"`);
    return found;
}

let everything = "";

const PLAY: { run: () => void; hold: number }[] = [
    { run: () => undefined, hold: 1600 },
    { run: () => tileMark("chat").focus(), hold: 1400 },
    { run: () => tileMark("chat").click(), hold: 1600 },
    { run: () => footMark(everything).focus(), hold: 1400 },
    { run: () => footMark(everything).click(), hold: 2600 }
];

export const launcher = defineScene({
    id: "launcher",
    path: `/tasks/l/${TASK_LIST_ID}`,
    actions: () => ({
        markLauncherReadAction: (input?: { scope: string; app?: string }) => {
            if (input?.scope === "all") for (const group of ["chat", "mail"]) marked.add(group);
            else if (input?.app) marked.add(input.app);
            return {};
        }
    }),
    api: (ctx) => ({ "GET /api/launcher/waiting": () => remaining(launcherWaiting(ctx)) }),
    render: (ctx) => <TaskBoard ctx={ctx} unread={launcherUnread(ctx)} />,
    prepare: (ctx) => {
        everything = label(ctx.locale, "nav.waitingList.markEverythingRead");
        openMenu(label(ctx.locale, "nav.labels.Tasks"));
    },
    animation: {
        frames: PLAY.length,
        step: (index) => PLAY[index]!.run(),
        hold: (index) => PLAY[index]!.hold
    }
});
