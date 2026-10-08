"use server";

/**
 * Linked calendars: the accounts and servers somebody reads calendars from, the
 * accounts they could link, and the holiday feeds on offer.
 */

import { z } from "zod";
import * as sync from "../lib/sync";
import { host } from "@polaris/app-host";
import { GOOGLE_APIS, googleApiEnableUrl } from "@polaris/core";
import { readGoogleCalendarApi, readGoogleTasksApi } from "../lib/google-api-state";
import * as sources from "../lib/sources";
import * as schemas from "../lib/schemas";
import type { SourceView } from "../lib/wire";
import { requireCalendarUser } from "../lib/access";
import { invalid, outcome, type Outcome } from "../lib/outcome";

/** A linked Google or Microsoft account, and where to authorize one for calendars. */
export interface LinkView {
    readonly id: string;
    readonly provider: "google" | "microsoft";
    readonly label: string;
    readonly grantsCalendar: boolean;
    /** Whether its tasks can be read: false for a Google account linked
     *  before tasks were asked for, which is offered the grant. */
    readonly grantsTasks: boolean;
    /** Already read as a calendar source here. */
    readonly used: boolean;
}

export interface AccountsView {
    readonly sources: SourceView[];
    /** The holiday and suggested addresses already subscribed to. */
    readonly subscribed: string[];
    readonly links: LinkView[];
    /** Where to start linking one more account, by provider. */
    readonly linkUrls: { readonly google: string; readonly microsoft: string };
    /** Whether that start goes anywhere: false while the operator has not set
     *  up the provider's sign-in application, so the screen says so instead. */
    readonly linkAvailable: { readonly google: boolean; readonly microsoft: boolean };
    /** Whether the reader runs this Polaris, and so can set that up. */
    readonly canManage: boolean;
    /** Where an administrator switches the Google Calendar API on, while a
     *  source here waits on it. Null for everybody else, and while none does. */
    readonly googleSetup: { readonly enableUrl: string; readonly project: string | null } | null;
    /** The Google Tasks API is off for this Polaris, so no Google account's
     *  tasks are shown. `enableUrl` is where an administrator switches it on;
     *  null for everybody else, who is told to ask. Null while it is not off. */
    readonly tasksApiOff: {
        readonly enableUrl: string | null;
        readonly project: string | null;
    } | null;
    readonly presets: typeof sync.CALDAV_PRESETS;
    readonly holidays: typeof sync.HOLIDAY_CALENDARS;
}

const CALENDAR_API = GOOGLE_APIS.find((api) => api.id === "calendar")!;
const TASKS_API = GOOGLE_APIS.find((api) => api.id === "tasks")!;

export async function loadAccountsAction(): Promise<Outcome<{ accounts: AccountsView }>> {
    return outcome(async () => {
        const user = await requireCalendarUser();
        const { readInstanceSettings } = await import("../lib/instance-settings");
        const admin = { admin: user.isAdmin };
        const [list, links, google, microsoft, settings, googleReady, microsoftReady] =
            await Promise.all([
                sources.listSources(user),
                host.calendarHost.listCalendarLinks(user.id),
                host.calendarHost.calendarLinkUrl("google"),
                host.calendarHost.calendarLinkUrl("microsoft"),
                readInstanceSettings(),
                host.calendarHost.calendarLinkAvailable("google", admin),
                host.calendarHost.calendarLinkAvailable("microsoft", admin)
            ]);
        const catalog = [
            ...sync.HOLIDAY_CALENDARS.map((feed) => feed.url),
            ...settings.suggested.map((entry) => entry.url)
        ];
        const used = new Set(list.map((source) => source.connectionId).filter(Boolean));
        const waiting = user.isAdmin && list.some((source) => source.status === "setup");
        const [apiState, clientProject] = waiting
            ? await Promise.all([readGoogleCalendarApi(), host.calendarHost.googleClientProject()])
            : [null, null];
        const tasksState = list.some((source) => source.kind === "google")
            ? await readGoogleTasksApi()
            : null;
        const tasksProject =
            tasksState?.state === "disabled" && user.isAdmin
                ? (tasksState.project ?? (await host.calendarHost.googleClientProject()))
                : null;
        return {
            accounts: {
                sources: list,
                subscribed: await sources.subscribedAmong(user, catalog),
                links: links.map((link) => ({ ...link, used: used.has(link.id) })),
                linkUrls: { google, microsoft },
                linkAvailable: { google: googleReady, microsoft: microsoftReady },
                canManage: user.isAdmin,
                googleSetup: waiting
                    ? {
                          enableUrl: googleApiEnableUrl(
                              CALENDAR_API.service,
                              apiState,
                              clientProject
                          ),
                          project: apiState?.project ?? clientProject
                      }
                    : null,
                tasksApiOff:
                    tasksState?.state === "disabled"
                        ? {
                              enableUrl: user.isAdmin
                                  ? googleApiEnableUrl(TASKS_API.service, tasksState, tasksProject)
                                  : null,
                              project: user.isAdmin ? tasksProject : null
                          }
                        : null,
                presets: sync.CALDAV_PRESETS,
                holidays: sync.HOLIDAY_CALENDARS
            }
        };
    });
}

export async function addFeedAction(input: unknown): Promise<Outcome<{ sourceId: string }>> {
    const parsed = schemas.icsSourceSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => ({
        sourceId: await sources.addFeed(await requireCalendarUser(), parsed.data)
    }));
}

export async function addCalDavAction(input: unknown): Promise<Outcome<{ sourceId: string }>> {
    const parsed = schemas.caldavSourceSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => ({
        sourceId: await sources.addCalDav(await requireCalendarUser(), parsed.data)
    }));
}

export async function addLinkedAccountAction(
    connectionId: unknown
): Promise<Outcome<{ sourceId: string }>> {
    const parsed = schemas.uuidSchema.safeParse(connectionId);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => ({
        sourceId: await sources.addLinkedAccount(await requireCalendarUser(), parsed.data)
    }));
}

/** The open calendar asking for its accounts' latest: every minute it is in
 *  view, and on Refresh (`soon`), which asks again sooner. */
export async function refreshOpenSourcesAction(soon?: unknown): Promise<Outcome<{ pulled: number }>> {
    const parsed = z.boolean().optional().safeParse(soon);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => ({
        pulled: await sources.refreshOpenSources(
            await requireCalendarUser(),
            parsed.data ? SOON_MS : sources.LIVE_PULL_AGE_MS
        )
    }));
}

/** The least time between two pulls Refresh asks for. */
const SOON_MS = 10_000;

export async function refreshSourceAction(id: unknown): Promise<Outcome<{ source: SourceView }>> {
    const parsed = schemas.uuidSchema.safeParse(id);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => ({
        source: await sources.refreshSource(await requireCalendarUser(), parsed.data)
    }));
}

const updateInput = z.object({
    id: schemas.uuidSchema,
    refreshMinutes: z
        .number()
        .int()
        .min(15)
        .max(7 * 24 * 60)
        .optional(),
    password: z.string().min(1).max(512).optional(),
    url: schemas.addressSchema.optional()
});

export async function updateSourceAction(input: unknown): Promise<Outcome<{ source: SourceView }>> {
    const parsed = updateInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        const { id, ...patch } = parsed.data;
        return { source: await sources.updateSource(await requireCalendarUser(), id, patch) };
    });
}

export async function removeSourceAction(id: unknown): Promise<Outcome<object>> {
    const parsed = schemas.uuidSchema.safeParse(id);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        await sources.removeSource(await requireCalendarUser(), parsed.data);
        return {};
    });
}

const conflictInput = z.object({
    objectId: schemas.uuidSchema,
    keep: z.enum(["mine", "theirs"]),
    zone: z.string().max(64).refine(schemas.isKnownZone)
});

/** Re-apply the local version a provider refused, or let the provider's stand. */
export async function resolveConflictAction(input: unknown): Promise<Outcome<object>> {
    const parsed = conflictInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        const user = await requireCalendarUser();
        const objects = await import("../lib/objects");
        await objects.writableObject(user, parsed.data.objectId);
        const engine = await import("../lib/sync-engine");
        await engine.resolveConflict(parsed.data.objectId, parsed.data.keep, parsed.data.zone);
        return {};
    });
}
