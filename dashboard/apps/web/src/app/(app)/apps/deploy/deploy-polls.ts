/**
 * What Deploy's screens ask again on a timer, asked through routes (see
 * `lib/poll-route`): a deploy screen stays open across Polaris updates, and an
 * action asked on a timer failed after every one until a reload. Each answers
 * exactly what the action it replaces answers.
 */

import type * as actions from "./actions";
import { readPoll } from "@/lib/poll-fetch";
import type * as glance from "./glance-actions";
import type * as projects from "./project-actions";
import type * as external from "./external-actions";
import type * as databases from "./database-actions";
import type * as cutover from "./dns-cutover-actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const databaseOverview = (databaseId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof databases.databaseOverviewAction>>(
        "/api/deploy/databases/overview",
        { databaseId },
        signal
    );

export const databaseProcesses = (databaseId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof databases.listDatabaseProcessesAction>>(
        "/api/deploy/databases/processes",
        { databaseId },
        signal
    );

export const cutoverPanel = (domainId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof cutover.cutoverPanelAction>>(
        "/api/deploy/cutover",
        { domainId },
        signal
    );

export const externalServiceStatus = (projectId: string, id: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof external.refreshExternalServiceAction>>(
        "/api/deploy/external-services/status",
        { projectId, id },
        signal
    );

export const projectGlance = (projectId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof glance.projectGlanceAction>>(
        "/api/deploy/projects/glance",
        { projectId },
        signal
    );

export const deployFreshness = (applicationId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof glance.deployFreshnessAction>>(
        "/api/deploy/freshness",
        { applicationId },
        signal
    );

export const imageUpdate = (applicationId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof glance.imageUpdateAction>>(
        "/api/deploy/image-update",
        { applicationId },
        signal
    );

export const deployments = (applicationId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.listDeploymentsAction>>(
        "/api/deploy/deployments",
        { applicationId },
        signal
    );

export const promotions = (projectId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof projects.listPromotionsAction>>(
        "/api/deploy/promotions",
        { projectId },
        signal
    );
