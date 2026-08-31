/**
 * The sections of a project, as the rail lists them.
 *
 * Their own module rather than a constant inside the shell, because they are
 * data and the shell is not: reaching them through it drags the project writes,
 * the session and the database in behind them, which is enough to stop a test
 * from reading a list of four strings.
 *
 * Worth testing on its own because a link is not something a type checker can
 * follow. The Settings tab pointed at a route that had never existed for as
 * long as it existed, and nothing anywhere failed - the only symptom was a 404
 * on the one screen a project is configured from.
 */

import { Activity, LayoutGrid, ScrollText, Settings, type LucideIcon } from "lucide-react";

export interface Section {
    label: string;
    /** Appended to the project's own path; "" is the project root. So a value
     *  that reads like a route of its own is not one here - it becomes a segment
     *  underneath, which is exactly how `/admin/settings` produced
     *  `/apps/deploy/<id>/admin/settings` and landed nowhere. */
    path: string;
    icon: LucideIcon;
    hint: string;
}

export const SECTIONS: Section[] = [
    { label: "Architecture", path: "", icon: LayoutGrid, hint: "Services and how they connect" },
    { label: "Observability", path: "/observability", icon: Activity, hint: "Metrics across the environment" },
    { label: "Logs", path: "/logs", icon: ScrollText, hint: "Every service's output in one stream" },
    { label: "Settings", path: "/settings", icon: Settings, hint: "Project configuration" }
];
