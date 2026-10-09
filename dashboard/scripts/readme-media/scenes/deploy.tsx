/** Deploy: every project at a glance, and one project's services on its canvas. */

import { Chrome } from "../runtime/chrome";
import { defineScene, type SceneContext } from "../runtime/scene";
import { label, press } from "../runtime/interact";
import { VIEWER } from "../fixtures/people";
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

export const deployProject = defineScene({
    id: "deploy-project",
    path: `/apps/deploy/${PROJECT_ID}`,
    params: { projectId: PROJECT_ID },
    actions: () => ({ deployFreshnessAction: () => null, imageUpdateAction: () => null }),
    render: (ctx) => <Project ctx={ctx} open={null} />
});

/** One release's live log, opened from the service's deployments. */
export const deployLogs = defineScene({
    id: "deploy-logs",
    path: `/apps/deploy/${PROJECT_ID}?service=${WEB_ID}`,
    params: { projectId: PROJECT_ID },
    actions: (ctx) => ({
        serviceFollowStateAction: () => ({ following: true }),
        serviceHistoryAction: () => [],
        listDeploymentsAction: () => deployments(ctx),
        deployFreshnessAction: () => null,
        imageUpdateAction: () => null
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
