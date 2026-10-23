/** Deploy: every project at a glance, and one project's services on its canvas. */

import { tourScene } from "../runtime/tour";
import { Chrome } from "../runtime/chrome";
import { defineScene, type SceneContext } from "../runtime/scene";
import { label, once, press } from "../runtime/interact";
import { VIEWER } from "../fixtures/people";
import { toWire } from "@/lib/app-bundles/wire";
import { ProjectsGrid } from "@/app/(app)/apps/deploy/projects-grid";
import { ProjectShell } from "@/app/(app)/apps/deploy/project-shell";
import { ProjectDetail } from "@/app/(app)/apps/deploy/project-detail";
import { PROJECT_CAPABILITIES } from "@polaris/core";
import type { ReactNode } from "react";
import {
    PROJECT_ID,
    WEB_ID,
    deployments,
    webLog,
    projectCards,
    projectSummary,
    shellProject
} from "../fixtures/deploy";

/** The deploy layout only narrows the catalogs a page is sent; this page has
 *  every catalog already, so the frame is the chrome alone. */
function DeployFrame({ children }: { children: ReactNode }) {
    return <Chrome>{children}</Chrome>;
}

export const deploy = defineScene({
    id: "deploy",
    path: "/apps/deploy",
    // No site import from a cPanel backup in the last day.
    api: () => ({ "GET /api/deploy/import/cpanel": () => ({ imports: [] }) }),
    render: (ctx) => (
        <DeployFrame>
            <ProjectsGrid projects={projectCards(ctx)} canManage localReady viewerId={VIEWER.id} />
        </DeployFrame>
    )
});

/** The page `/apps/deploy/[projectId]` draws inside its project layout. */
function Project({ ctx, open }: { ctx: SceneContext; open: string | null }) {
    return (
        <DeployFrame>
            <ProjectShell
                project={shellProject(ctx)}
                projects={projectCards(ctx).map((card) => ({ id: card.id, name: card.name }))}
                staged={[]}
                canManage
            >
                <ProjectDetail
                    project={projectSummary()}
                    canManage
                    capabilities={PROJECT_CAPABILITIES}
                    localReady
                    activeEnvironmentId={null}
                    openService={open}
                />
            </ProjectShell>
        </DeployFrame>
    );
}

const deployProjectStill = defineScene({
    id: "deploy-project",
    path: `/apps/deploy/${PROJECT_ID}`,
    params: { projectId: PROJECT_ID },
    actions: () => ({ deployFreshnessAction: () => null, imageUpdateAction: () => null }),
    // The same two answers, read by the service panel's poll once it has been open a while.
    api: () => ({
        "GET /api/deploy/freshness": () => ({ value: null }),
        "GET /api/deploy/image-update": () => ({ value: null })
    }),
    render: (ctx) => <Project ctx={ctx} open={null} />
});

/** One release's live log, opened from the service's deployments. */
export const deployLogs = defineScene({
    id: "deploy-logs",
    path: `/apps/deploy/${PROJECT_ID}?service=${WEB_ID}`,
    params: { projectId: PROJECT_ID },
    actions: () => ({
        serviceFollowStateAction: () => ({ following: true }),
        serviceHistoryAction: () => [],
        deployFreshnessAction: () => null,
        imageUpdateAction: () => null
    }),
    api: (ctx) => ({
        "GET /api/deploy/deployments": () => ({ value: toWire(deployments(ctx)) })
    }),
    streams: (ctx) => ({
        "/api/deploy/logs/stream": [
            { type: "following", data: { serviceId: WEB_ID, containers: ["storefront-web"] } },
            { type: "lines", data: webLog(ctx) }
        ]
    }),
    render: (ctx) => <Project ctx={ctx} open={WEB_ID} />,
    prepare: (ctx) => press(label(ctx.locale, "deployService.deployments.viewLogs"))
});

/** Every project, one opened on its canvas, then its web service's live log. */
export const deployProject = tourScene([deployProjectStill, deploy, deployLogs], [
    { view: 1, hold: 1700 },
    { view: 0, hold: 2000 },
    { view: 2, run: (ctx) => once(() => deployLogs.prepare?.(ctx)), hold: 3400, advance: 1600 }
]);
