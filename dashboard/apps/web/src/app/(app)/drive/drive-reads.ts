/**
 * What the Drive screens read when they open, asked through routes (see
 * `lib/poll-route`): server actions from one tab run one at a time, so a read
 * on open waited behind every other one, and a press waited behind them all.
 * Each answers exactly what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as transferActionsModule from "@/app/(app)/drive/transfer-actions";
import type * as snippetActionsModule from "@/app/(app)/drive/snippets/snippet-actions";
import type * as sharingActionsModule from "@/app/(app)/drive/sharing-actions";
import type * as shareActionsModule from "@/app/(app)/drive/share-actions";
import type * as driveActionsModule from "@/app/(app)/drive/actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const linkedAccounts = (provider: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof driveActionsModule.linkedAccountsAction>>(
        "/api/drive/linked-accounts",
        { provider },
        signal
    );

export const driveJobs = (connectionId?: string, folder?: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof driveActionsModule.driveJobsAction>>(
        "/api/drive/jobs",
        { ...(connectionId ? { connectionId } : {}), ...(folder ? { folder } : {}) },
        signal
    );

export const unasShares = (connectionId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof driveActionsModule.discoverUnasSharesAction>>(
        "/api/drive/unas-shares",
        { connectionId },
        signal
    );

export const removalPlan = (connectionId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof driveActionsModule.connectionRemovalPlanAction>>(
        "/api/drive/removal-plan",
        { connectionId },
        signal
    );

export const myShareGroups = (signal?: AbortSignal) =>
    readPoll<Answer<typeof sharingActionsModule.myShareGroupsAction>>(
        "/api/drive/share-groups",
        {},
        signal
    );

export const itemShares = (connectionId: string, path: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof sharingActionsModule.listItemSharesAction>>(
        "/api/drive/item-shares",
        { connectionId, path },
        signal
    );

export const transferOrgs = (signal?: AbortSignal) =>
    readPoll<Answer<typeof transferActionsModule.transferOrgsAction>>(
        "/api/drive/transfer-orgs",
        {},
        signal
    );

export const waitingTransfers = (signal?: AbortSignal) =>
    readPoll<Answer<typeof transferActionsModule.waitingTransfersAction>>(
        "/api/drive/transfers/waiting",
        {},
        signal
    );

export const sentTransfers = (signal?: AbortSignal) =>
    readPoll<Answer<typeof transferActionsModule.sentTransfersAction>>(
        "/api/drive/transfers/sent",
        {},
        signal
    );

export const shareLogs = (shareId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof shareActionsModule.getShareLogsAction>>(
        "/api/drive/share-logs",
        { shareId },
        signal
    );

export const snippetLogs = (snippetId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof snippetActionsModule.getSnippetLogsAction>>(
        "/api/drive/snippet-logs",
        { snippetId },
        signal
    );
