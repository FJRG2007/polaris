/**
 * What the Network filter reads when it opens and on a timer, asked through a
 * route (see `lib/poll-route`): the screen stays open across Polaris updates,
 * and an action asked on a timer failed after every one until a reload. Server
 * actions from one tab also run one at a time, so the screen's reads queued
 * behind one another; as routes they go at once. Each answers exactly what the
 * action it replaces answers. Changes stay actions.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as actions from "./actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const dnsInsights = (filter: object, fresh: boolean, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.dnsInsightsAction>>(
        "/api/dns-blocker/insights",
        { filter: JSON.stringify(filter), fresh: String(fresh) },
        signal
    );

export const dnsTail = (filter: object, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.dnsTailAction>>(
        "/api/dns-blocker/tail",
        { filter: JSON.stringify(filter) },
        signal
    );

export const dnsStatus = (signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.dnsBlockerStatusAction>>("/api/dns-blocker/status", {}, signal);

export const dnsLists = (signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.dnsListsAction>>("/api/dns-blocker/lists", {}, signal);

export const dnsHistory = (input: object, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.dnsHistoryAction>>(
        "/api/dns-blocker/history",
        { input: JSON.stringify(input) },
        signal
    );

export const dnsDevices = (input: object, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.dnsDevicesAction>>(
        "/api/dns-blocker/devices",
        { input: JSON.stringify(input) },
        signal
    );

export const dnsClients = (fresh: boolean, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.dnsClientsAction>>(
        "/api/dns-blocker/clients",
        { fresh: String(fresh) },
        signal
    );

export const dnsReputation = (input: object, signal?: AbortSignal) =>
    readPoll<Answer<typeof actions.dnsReputationAction>>(
        "/api/dns-blocker/reputation",
        { input: JSON.stringify(input) },
        signal
    );
