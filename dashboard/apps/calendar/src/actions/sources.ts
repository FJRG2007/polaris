"use server";

/**
 * Linked calendars: the accounts and servers somebody reads calendars from, the
 * accounts they could link, and the holiday feeds on offer.
 */

import { z } from "zod";
import * as sync from "../lib/sync";
import { host } from "@polaris/app-host";
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
    /** Already read as a calendar source here. */
    readonly used: boolean;
}

export interface AccountsView {
    readonly sources: SourceView[];
    readonly links: LinkView[];
    /** Where to start linking one more account, by provider. */
    readonly linkUrls: { readonly google: string; readonly microsoft: string };
    readonly presets: typeof sync.CALDAV_PRESETS;
    readonly holidays: typeof sync.HOLIDAY_CALENDARS;
}

export async function loadAccountsAction(): Promise<Outcome<{ accounts: AccountsView }>> {
    return outcome(async () => {
        const user = await requireCalendarUser();
        const [list, links, google, microsoft] = await Promise.all([
            sources.listSources(user),
            host.calendarHost.listCalendarLinks(user.id),
            host.calendarHost.calendarLinkUrl("google"),
            host.calendarHost.calendarLinkUrl("microsoft")
        ]);
        const used = new Set(list.map((source) => source.connectionId).filter(Boolean));
        return {
            accounts: {
                sources: list,
                links: links.map((link) => ({ ...link, used: used.has(link.id) })),
                linkUrls: { google, microsoft },
                presets: sync.CALDAV_PRESETS,
                holidays: sync.HOLIDAY_CALENDARS
            }
        };
    });
}

export async function addFeedAction(input: unknown): Promise<Outcome<{ sourceId: string }>> {
    const parsed = schemas.icsSourceSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => ({ sourceId: await sources.addFeed(await requireCalendarUser(), parsed.data) }));
}

export async function addCalDavAction(input: unknown): Promise<Outcome<{ sourceId: string }>> {
    const parsed = schemas.caldavSourceSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => ({ sourceId: await sources.addCalDav(await requireCalendarUser(), parsed.data) }));
}

export async function addLinkedAccountAction(connectionId: unknown): Promise<Outcome<{ sourceId: string }>> {
    const parsed = schemas.uuidSchema.safeParse(connectionId);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => ({
        sourceId: await sources.addLinkedAccount(await requireCalendarUser(), parsed.data)
    }));
}

export async function refreshSourceAction(id: unknown): Promise<Outcome<{ source: SourceView }>> {
    const parsed = schemas.uuidSchema.safeParse(id);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => ({ source: await sources.refreshSource(await requireCalendarUser(), parsed.data) }));
}

const updateInput = z.object({
    id: schemas.uuidSchema,
    refreshMinutes: z.number().int().min(15).max(7 * 24 * 60).optional(),
    password: z.string().min(1).max(512).optional()
});

export async function updateSourceAction(input: unknown): Promise<Outcome<object>> {
    const parsed = updateInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        const { id, ...patch } = parsed.data;
        await sources.updateSource(await requireCalendarUser(), id, patch);
        return {};
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
