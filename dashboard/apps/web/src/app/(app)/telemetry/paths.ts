/**
 * The addresses of Telemetry's screens. Each section of a project is a real
 * route, so a link somebody sends lands on what they were looking at.
 *
 *   /telemetry                                  every project
 *   /telemetry/issues                           every issue, across projects
 *   /telemetry/<project>                        a project's issues
 *   /telemetry/<project>/issues/<issue>         one issue
 *   /telemetry/<project>/<section>[/<id>]       events, releases, setup...
 */

import { DEFAULT_SECTION } from "./project-sections";

export const PROJECTS_HREF = "/telemetry";
export const ISSUES_HREF = "/telemetry/issues";

export function projectHref(projectId: string, section?: string, id?: string | null): string {
    const base = `/telemetry/${encodeURIComponent(projectId)}`;
    if (!section || (section === DEFAULT_SECTION && !id)) return base;
    return id ? `${base}/${section}/${encodeURIComponent(id)}` : `${base}/${section}`;
}

export function issueHref(projectId: string, issueId: string): string {
    return projectHref(projectId, DEFAULT_SECTION, issueId);
}
