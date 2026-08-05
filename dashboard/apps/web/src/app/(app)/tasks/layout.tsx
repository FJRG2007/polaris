/**
 * Wraps every Tasks screen so one live connection covers all of them. Holding it
 * here rather than in each page means moving between the sidebar, a list and a
 * task does not drop and reopen the stream.
 *
 * Nothing is fetched at this level on purpose: a layout's data does not reliably
 * re-render on a refresh, and a refresh is exactly what this layout exists to
 * trigger.
 */

import type { ReactNode } from "react";
import { TasksLiveRefresh } from "./live-refresh";

export default function TasksLayout({ children }: { children: ReactNode }) {
    return (
        <>
            <TasksLiveRefresh />
            {children}
        </>
    );
}
