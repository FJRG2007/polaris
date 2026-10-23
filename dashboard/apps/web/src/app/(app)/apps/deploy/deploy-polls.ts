/**
 * What Deploy's screens ask again on a timer, asked through routes (see
 * `lib/poll-route`): a deploy screen stays open across Polaris updates, and an
 * action asked on a timer failed after every one until a reload. Each answers
 * exactly what the action it replaces answers.
 */

import type * as actions from "./actions";
import { readPoll } from "@/lib/poll-fetch";
import type * as variableGroupActionsModule from "@/app/(app)/apps/deploy/variable-group-actions";
import type * as variableActionsModule from "@/app/(app)/apps/deploy/variable-actions";
import type * as sourceActionsModule from "@/app/(app)/apps/deploy/source-actions";
import type * as scalingActionsModule from "@/app/(app)/apps/deploy/scaling-actions";
import type * as publicNetworkingActionsModule from "@/app/(app)/apps/deploy/public-networking-actions";
import type * as gpuActionsModule from "@/app/(app)/apps/deploy/gpu-actions";
import type * as fixActionsModule from "@/app/(app)/apps/deploy/fix-actions";
import type * as deployBehaviourActionsModule from "@/app/(app)/apps/deploy/deploy-behaviour-actions";
import type * as cronActionsModule from "@/app/(app)/apps/deploy/cron-actions";
import type * as automationActionsModule from "@/app/(app)/apps/deploy/automation-actions";
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

export const buildMachine = (applicationId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof sourceActionsModule.buildMachineAction>>(
        "/api/deploy/services/build-machine",
        { applicationId },
        signal
    );

export const serviceCronRuns = (applicationId: string, cronId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof cronActionsModule.listServiceCronRunsAction>>(
        "/api/deploy/services/cron-runs",
        { applicationId, cronId },
        signal
    );

export const deployBehaviour = (applicationId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof deployBehaviourActionsModule.deployBehaviourAction>>(
        "/api/deploy/services/deploy-behaviour",
        { applicationId },
        signal
    );

export const databaseConnection = (databaseId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.databaseConnectionAction>>(
        "/api/deploy/databases/connection",
        { databaseId },
        signal
    );

export const databaseInstances = (environmentId: string, engine: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.listDatabaseInstancesAction>>(
        "/api/deploy/databases/instances",
        { environmentId, engine },
        signal
    );

export const providerChoices = (connectionId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof external.listProviderChoicesAction>>(
        "/api/deploy/providers/choices",
        { connectionId },
        signal
    );

export const providerAccounts = (signal?: AbortSignal) =>
    readPoll<Answer<typeof external.listProviderAccountsAction>>(
        "/api/deploy/providers/accounts",
        {},
        signal
    );

export const moveOutPlan = (projectId: string, applicationId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof external.moveOutPlanAction>>(
        "/api/deploy/move/out-plan",
        { projectId, applicationId },
        signal
    );

export const moveHomePlan = (projectId: string, serviceId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof external.moveHomePlanAction>>(
        "/api/deploy/move/home-plan",
        { projectId, serviceId },
        signal
    );

export const serviceGpu = (applicationId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof gpuActionsModule.serviceGpuAction>>(
        "/api/deploy/services/gpu",
        { applicationId },
        signal
    );

export const deploymentDiagnosis = (deploymentId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof fixActionsModule.deploymentDiagnosisAction>>(
        "/api/deploy/deployments/diagnosis",
        { deploymentId },
        signal
    );

export const servicePorts = (applicationId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof publicNetworkingActionsModule.servicePortsAction>>(
        "/api/deploy/services/ports",
        { applicationId },
        signal
    );

export const domainReadings = (applicationId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof publicNetworkingActionsModule.domainReadingsAction>>(
        "/api/deploy/services/domain-readings",
        { applicationId },
        signal
    );

export const tcpProxies = (applicationId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof publicNetworkingActionsModule.tcpProxiesAction>>(
        "/api/deploy/services/tcp-proxies",
        { applicationId },
        signal
    );

export const serviceScaling = (applicationId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof scalingActionsModule.serviceScalingAction>>(
        "/api/deploy/services/scaling",
        { applicationId },
        signal
    );

export const serviceFollowState = (applicationId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.serviceFollowStateAction>>(
        "/api/deploy/services/follow-state",
        { applicationId },
        signal
    );

export const serviceHistory = (applicationId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.serviceHistoryAction>>(
        "/api/deploy/services/history",
        { applicationId },
        signal
    );

export const deployServers = (environmentId?: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.listDeployServersAction>>(
        "/api/deploy/servers",
        { ...(environmentId ? { environmentId } : {}) },
        signal
    );

export const quickTunnelStatus = (applicationId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.quickTunnelStatusAction>>(
        "/api/deploy/services/quick-tunnel",
        { applicationId },
        signal
    );

export const ngrokTunnelStatus = (applicationId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.ngrokTunnelStatusAction>>(
        "/api/deploy/services/ngrok-tunnel",
        { applicationId },
        signal
    );

export const namedTunnelStatus = (applicationId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.namedTunnelStatusAction>>(
        "/api/deploy/services/named-tunnel",
        { applicationId },
        signal
    );

export const domainHealth = (applicationId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.domainHealthAction>>(
        "/api/deploy/services/domain-health",
        { applicationId },
        signal
    );

export const cloudflareAccountStatus = (signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.cloudflareAccountStatusAction>>(
        "/api/deploy/cloudflare/account-status",
        {},
        signal
    );

export const serviceSource = (applicationId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof sourceActionsModule.serviceSourceAction>>(
        "/api/deploy/services/source",
        { applicationId },
        signal
    );

export const uploadedSource = (applicationId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof sourceActionsModule.uploadedSourceAction>>(
        "/api/deploy/services/uploaded-source",
        { applicationId },
        signal
    );

export const automationRuns = (
    input: { projectId: string; automationId: string },
    signal?: AbortSignal
) =>
    readPoll<Answer<typeof automationActionsModule.listAutomationRunsAction>>(
        "/api/deploy/automations/runs",
        input,
        signal
    );

export const promotionPreview = (
    input: { sourceEnvironmentId: string; targetEnvironmentId: string },
    signal?: AbortSignal
) =>
    readPoll<Answer<typeof projects.previewPromotionAction>>(
        "/api/deploy/promotions/preview",
        input,
        signal
    );

export const volumeDetail = (volumeId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof projects.volumeDetailAction>>(
        "/api/deploy/volumes/detail",
        { volumeId },
        signal
    );

export const variableGroupReach = (input: { groupId: string }, signal?: AbortSignal) =>
    readPoll<Answer<typeof variableGroupActionsModule.variableGroupReachAction>>(
        "/api/deploy/variable-groups/reach",
        input,
        signal
    );

export const serviceTags = (input: { applicationId: string }, signal?: AbortSignal) =>
    readPoll<Answer<typeof variableGroupActionsModule.serviceTagsAction>>(
        "/api/deploy/services/tags",
        input,
        signal
    );

export const envScopeValues = (
    input: { scope: "application" | "environment" | "group"; scopeId: string },
    signal?: AbortSignal
) =>
    readPoll<Answer<typeof variableActionsModule.revealEnvScopeAction>>(
        "/api/deploy/variables/reveal",
        input,
        signal
    );

export const nasConnections = (signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.listNasConnectionsAction>>(
        "/api/deploy/nas-connections",
        {},
        signal
    );
