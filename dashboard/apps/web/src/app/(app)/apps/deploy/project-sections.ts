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

import type { NamespaceKey } from "@/lib/i18n/types";
import { Activity, Cloud, LayoutGrid, ScrollText, Settings, type LucideIcon } from "lucide-react";

export interface Section {
    /** Catalog key of the tab's name, in the deployProject namespace. */
    label: NamespaceKey<"deployProject">;
    /** Appended to the project's own path; "" is the project root. So a value
     *  that reads like a route of its own is not one here - it becomes a segment
     *  underneath, which is exactly how `/admin/settings` produced
     *  `/apps/deploy/<id>/admin/settings` and landed nowhere. */
    path: string;
    icon: LucideIcon;
    /** Catalog key of the tab's tooltip, in the deployProject namespace. */
    hint: NamespaceKey<"deployProject">;
}

export const SECTIONS: Section[] = [
    { label: "sections.architecture.label", path: "", icon: LayoutGrid, hint: "sections.architecture.hint" },
    { label: "sections.elsewhere.label", path: "/elsewhere", icon: Cloud, hint: "sections.elsewhere.hint" },
    { label: "sections.observability.label", path: "/observability", icon: Activity, hint: "sections.observability.hint" },
    { label: "sections.logs.label", path: "/logs", icon: ScrollText, hint: "sections.logs.hint" },
    { label: "sections.settings.label", path: "/settings", icon: Settings, hint: "sections.settings.hint" }
];
