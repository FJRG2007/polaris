/**
 * What the operator screens read when they open, asked through routes (see
 * `lib/poll-route`): server actions from one tab run one at a time, so a read
 * on open waited behind every other one, and a press waited behind them all.
 * Each answers exactly what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as settingsActionsModule from "@/app/(app)/admin/settings/actions";
import type * as retentionActionsModule from "@/app/(app)/admin/retention/actions";
import type * as inboxActionsModule from "@/app/(app)/admin/inbox/actions";
import type * as domainsActionsModule from "@/app/(app)/admin/domains/actions";
import type * as chatActionsModule from "@/app/(app)/admin/chat/actions";
import type * as dnsActionsModule from "@/app/(app)/account/domains/dns-actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const callServerSettings = (signal?: AbortSignal) =>
    readPoll<Answer<typeof chatActionsModule.callServerSettingsAction>>(
        "/api/admin/call-server",
        {},
        signal
    );

export const dnsZones = (signal?: AbortSignal) =>
    readPoll<Answer<typeof dnsActionsModule.listDnsZonesAction>>("/api/domains/zones", {}, signal);

export const networkStatus = (signal?: AbortSignal) =>
    readPoll<Answer<typeof domainsActionsModule.networkStatusAction>>(
        "/api/admin/network-status",
        {},
        signal
    );

export const firstDiscordChannel = (signal?: AbortSignal) =>
    readPoll<Answer<typeof inboxActionsModule.firstDiscordChannelAction>>(
        "/api/admin/inbox/discord-channel",
        {},
        signal
    );

export const channelTargets = (channelId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof inboxActionsModule.listChannelTargetsAction>>(
        "/api/admin/inbox/channel-targets",
        { channelId },
        signal
    );

export const inboxAgents = (signal?: AbortSignal) =>
    readPoll<Answer<typeof inboxActionsModule.listAgentsAction>>(
        "/api/admin/inbox/agents",
        {},
        signal
    );

export const inboxContacts = (signal?: AbortSignal) =>
    readPoll<Answer<typeof inboxActionsModule.listContactsAction>>(
        "/api/admin/inbox/contacts",
        {},
        signal
    );

export const mailBodyHeld = (signal?: AbortSignal) =>
    readPoll<Answer<typeof retentionActionsModule.mailBodyHeldAction>>(
        "/api/admin/retention/mail-bodies",
        {},
        signal
    );

export const ownVulnerabilities = (signal?: AbortSignal) =>
    readPoll<Answer<typeof settingsActionsModule.ownVulnerabilitiesAction>>(
        "/api/admin/own-vulnerabilities",
        {},
        signal
    );
