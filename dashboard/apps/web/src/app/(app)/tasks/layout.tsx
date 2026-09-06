/**
 * Wraps every Tasks screen so one live connection covers all of them. Holding it
 * here rather than in each page means moving between the sidebar, a list and a
 * task does not drop and reopen the stream.
 *
 * Nothing is fetched at this level on purpose: a layout's data does not reliably
 * re-render on a refresh, and a refresh is exactly what this layout exists to
 * trigger.
 *
 * It also draws people plainly. Work is where somebody is a name in a column -
 * an assignee, a mention, a row in a picker - and a ring around the face and a
 * gradient across the letters are for the places somebody is being introduced
 * rather than looked up. Chat and a profile keep them; see `PlainNames`.
 */

import type { ReactNode } from "react";
import { TasksLiveRefresh } from "./live-refresh";
import { PlainNames } from "@/components/person-name";
import { PlaceRecorder } from "@/components/place-recorder";

export default function TasksLayout({ children }: { children: ReactNode }) {
    return (
        <PlainNames>
            <TasksLiveRefresh />
            {/* A task's own URL is deliberately not remembered: it is a deep link
                to one record, and the one thing worse than opening on the app's
                front door is opening on a task somebody deleted. The list it
                lives in is what comes back. */}
            <PlaceRecorder appId="tasks" root="/tasks" skip={["/tasks/t/"]} />
            {children}
        </PlainNames>
    );
}
