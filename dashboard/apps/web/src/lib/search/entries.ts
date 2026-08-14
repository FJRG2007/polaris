/**
 * What the global search can find, and how it is labelled.
 *
 * Navigation entries are derived from the same registries that draw the app
 * switcher and the left rail, so a page added there becomes findable without a
 * second list to keep in step. Resources (deploy projects, services, servers,
 * runner pools, installed apps) come from /api/search already scoped to what the
 * caller may open, and are mapped here to the same entry shape so one index
 * covers both.
 */

import { APP_SECTIONS, APP_SUBAPPS, POLARIS_APPS } from "@/lib/apps";
import {
    Boxes,
    Code2,
    Database,
    LayoutGrid,
    Rocket,
    Server,
    Workflow,
    type LucideIcon
} from "lucide-react";

export type SearchResourceKind =
    | "project"
    | "service"
    | "database"
    | "server"
    | "runner"
    | "installed"
    | "snippet";

/** A named thing the user owns, as the search endpoint returns it. */
export interface SearchResource {
    id: string;
    kind: SearchResourceKind;
    label: string;
    /** Where it lives - the project, environment or host it belongs to. */
    context: string;
    href: string;
}

export interface CommandEntry {
    id: string;
    label: string;
    /** Heading the entry is listed under. */
    group: string;
    href: string;
    icon: LucideIcon;
    /** Second line: what the destination is, or where the resource lives. */
    context?: string;
    /** Terms that should also match, beyond the label. */
    keywords?: string[];
}

const RESOURCE_ICONS: Record<SearchResourceKind, LucideIcon> = {
    project: Boxes,
    service: Rocket,
    database: Database,
    server: Server,
    runner: Workflow,
    installed: LayoutGrid,
    snippet: Code2
};

const RESOURCE_GROUPS: Record<SearchResourceKind, string> = {
    project: "Deploy",
    service: "Deploy",
    database: "Deploy",
    server: "Servers",
    runner: "Runners",
    installed: "Apps",
    snippet: "Snippets"
};

/**
 * Every page the user can reach, grouped by the app that owns it. `appIds` is
 * what this account may actually open, resolved on the server; search must not
 * offer a screen that turns the person away when they pick it. The account's own
 * pages are always in, since everybody has an account.
 */
export function navigationEntries(isAdmin: boolean, appIds: readonly string[]): CommandEntry[] {
    const entries: CommandEntry[] = [];
    const allowed = new Set([...appIds, "account"]);
    for (const app of POLARIS_APPS) {
        if (app.adminOnly && !isAdmin) continue;
        if (!allowed.has(app.id)) continue;
        const sections = APP_SECTIONS[app.id] ?? [];
        // An app whose landing page is already one of its sections would otherwise
        // be listed twice under the same href.
        const root = sections.find((section) => section.href === app.href);
        if (!root) {
            entries.push({
                id: `app:${app.id}`,
                label: app.label,
                group: app.label,
                href: app.href,
                icon: app.icon,
                context: app.description
            });
        }
        for (const section of sections) {
            entries.push({
                id: `section:${section.href}`,
                label: section.label,
                group: app.label,
                href: section.href,
                icon: section.icon,
                // The app's own name and purpose ride on its landing section, so
                // "watch" or "files" finds it however the section is titled.
                keywords:
                    section === root
                        ? [...(section.keywords ?? []), app.label, app.description]
                        : section.keywords
            });
        }
    }

    // Screens that live one level down, inside a section big enough to have its
    // own rail. They are not in any app's section list, so without this the only
    // way to reach Runs would be to already be in Runners - which is exactly the
    // sort of page search exists for.
    for (const subapp of APP_SUBAPPS) {
        // A subject lives inside an app, so it is only findable when that app is.
        const owner = POLARIS_APPS.find(
            (app) =>
                subapp.base.startsWith(app.href) ||
                app.match?.some((base) => subapp.base.startsWith(base))
        );
        if (owner && !allowed.has(owner.id)) continue;
        for (const section of subapp.sections) {
            if (entries.some((entry) => entry.href === section.href)) continue;
            entries.push({
                id: `section:${section.href}`,
                label: `${subapp.label}: ${section.label}`,
                group: subapp.label,
                href: section.href,
                icon: section.icon,
                keywords: section.keywords
            });
        }
    }
    return entries;
}

export function resourceEntries(resources: SearchResource[]): CommandEntry[] {
    return resources.map((resource) => ({
        id: `${resource.kind}:${resource.id}`,
        label: resource.label,
        group: RESOURCE_GROUPS[resource.kind],
        href: resource.href,
        icon: RESOURCE_ICONS[resource.kind],
        context: resource.context
    }));
}
