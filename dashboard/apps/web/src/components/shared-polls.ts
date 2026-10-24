/**
 * What the shared components read when they open, asked through routes (see
 * `lib/poll-route`): server actions from one tab run one at a time, so a read
 * on open waited behind every other one, and a press waited behind them all.
 * Each answers exactly what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as namespaceActionsModule from "@/components/i18n/namespace-actions";
import type * as tourActionsModule from "@/app/(app)/tour-actions";
import type * as setupActionsModule from "@/app/(app)/setup-actions";
import type * as searchActionsModule from "@/app/(app)/search-actions";
import type * as activityActionsModule from "@/app/(app)/drive/activity-actions";
import type * as diskAlertActionsModule from "@/app/(app)/disk-alert-actions";
import type * as breakdownActionsModule from "@/app/(app)/breakdown-actions";
import type * as automationActions from "@/app/(app)/automations/actions";
import type * as restoreActionsModule from "@/app/(app)/apps/deploy/restore-actions";
import type * as stepUpActionsModule from "@/app/(app)/account/step-up-actions";
import type * as preferenceActions from "@/app/(app)/account/preferences/actions";
import type * as securityActionsModule from "@/app/(app)/account/domains/security-actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const presenceNow = (signal?: AbortSignal) =>
    readPoll<Answer<typeof preferenceActions.presenceNowAction>>(
        "/api/account/presence",
        {},
        signal
    );

export const noticeChannels = (signal?: AbortSignal) =>
    readPoll<Answer<typeof automationActions.noticeChannelsAction>>(
        "/api/automations/notice-channels",
        {},
        signal
    );

export const recentSearches = (signal?: AbortSignal) =>
    readPoll<Answer<typeof searchActionsModule.listRecentSearchesAction>>(
        "/api/search/recent",
        {},
        signal
    );

export const diskAlerts = (signal?: AbortSignal) =>
    readPoll<Answer<typeof diskAlertActionsModule.diskAlertsAction>>(
        "/api/disk-alerts",
        {},
        signal
    );

export const domainSecurity = (
    ref: Parameters<typeof securityActionsModule.readDomainSecurityAction>[0],
    domain: string,
    signal?: AbortSignal
) =>
    readPoll<Answer<typeof securityActionsModule.readDomainSecurityAction>>(
        "/api/domains/security",
        { ref: JSON.stringify(ref), domain },
        signal
    );

export const domainSecurityPlan = (
    ref: Parameters<typeof securityActionsModule.planDomainSecurityAction>[0],
    domain: string,
    policy: Parameters<typeof securityActionsModule.planDomainSecurityAction>[2],
    signal?: AbortSignal,
    reportTo?: string | null
) =>
    readPoll<Answer<typeof securityActionsModule.planDomainSecurityAction>>(
        "/api/domains/security/plan",
        {
            ref: JSON.stringify(ref),
            domain,
            policy: JSON.stringify(policy),
            ...(reportTo ? { reportTo } : {})
        },
        signal
    );

export const securityInventory = (signal?: AbortSignal) =>
    readPoll<Answer<typeof securityActionsModule.securityInventoryAction>>(
        "/api/domains/security/inventory",
        {},
        signal
    );

export const namespaceMessages = (names: string[], signal?: AbortSignal) =>
    readPoll<Answer<typeof namespaceActionsModule.namespaceMessagesAction>>(
        "/api/i18n/namespaces",
        { names: names.join(",") },
        signal
    );

export const subjectBreakdown = (
    input: Parameters<typeof breakdownActionsModule.subjectBreakdownAction>[0],
    signal?: AbortSignal
) =>
    readPoll<Answer<typeof breakdownActionsModule.subjectBreakdownAction>>(
        "/api/watch/breakdown",
        { input: JSON.stringify(input) },
        signal
    );

export const restoreHistory = (
    target: Parameters<typeof restoreActionsModule.listHistoryAction>[0],
    signal?: AbortSignal
) =>
    readPoll<Answer<typeof restoreActionsModule.listHistoryAction>>(
        "/api/deploy/restore-points",
        { target: JSON.stringify(target) },
        signal
    );

export const setupState = (signal?: AbortSignal) =>
    readPoll<Answer<typeof setupActionsModule.setupStateAction>>("/api/setup/state", {}, signal);

export const setupInstalled = (signal?: AbortSignal) =>
    readPoll<Answer<typeof setupActionsModule.setupInstalledAction>>(
        "/api/setup/installed",
        {},
        signal
    );

export const stepUpOptions = (signal?: AbortSignal) =>
    readPoll<Answer<typeof stepUpActionsModule.stepUpOptionsAction>>(
        "/api/account/step-up/options",
        {},
        signal
    );

export const shouldOfferOverview = (signal?: AbortSignal) =>
    readPoll<Answer<typeof tourActionsModule.shouldOfferOverviewAction>>(
        "/api/tours/overview-offer",
        {},
        signal
    );

export const userProfile = (userId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof activityActionsModule.getUserProfileAction>>(
        "/api/users/profile",
        { userId },
        signal
    );
