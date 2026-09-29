"use server";

/**
 * Connecting Linear and Jira to a space, and pulling from them.
 *
 * A connection holds somebody's personal credential for a system Polaris does not
 * run, so every one of these re-checks that the connection is theirs rather than
 * trusting the id the screen sent - and the secret is written, never read back.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import * as access from "@/lib/tasks/access";
import { requirePermission } from "@/lib/session";
import { syncTracker } from "@/lib/tasks/trackers/sync";
import { getTranslations } from "@/lib/i18n/request";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import * as trackers from "@/lib/tasks/trackers/service";

const TRACKERS_PATH = "/tasks/trackers";

/**
 * A sentence the tracker code wrote, in the reader's language.
 *
 * The sync and the check run from a schedule as well as from this screen, and
 * what they say is stored on the connection as it was said, so the fixed
 * sentences Polaris writes are translated here, where somebody is reading them.
 * What a provider said about its own refusal is its words and passes through.
 */
function trackerSentence(t: NamespaceTranslator<"tasks">, text: string): string {
    const connectedAs = /^Connected as (.+)\.$/.exec(text);
    if (connectedAs) return t("trackers.reasons.connectedAs", { name: connectedAs[1] ?? "" });
    const known: Record<string, Parameters<typeof t>[0]> = {
        "That connection no longer exists.": "trackers.reasons.gone",
        "This build does not know that tracker.": "trackers.reasons.unknownTracker",
        "This connection has no key stored on it.": "trackers.reasons.noKey",
        "That connection has no key stored on it.": "trackers.reasons.noKey",
        "The tracker did not answer.": "trackers.reasons.noAnswer",
        "That connection is not one of yours.": "trackers.reasons.notYours",
        "It did not answer.": "trackers.reasons.itDidNotAnswer",
        "Linear did not answer.": "trackers.reasons.linearNoAnswer",
        "Jira did not answer.": "trackers.reasons.jiraNoAnswer",
        "This Jira connection has no site on it.": "trackers.reasons.noSite"
    };
    const key = known[text];
    return key ? t(key) : text;
}

const saveSchema = z.object({
    id: z.string().uuid().nullable().default(null),
    provider: z.enum(core.ISSUE_TRACKERS),
    label: z.string().trim().min(1, "trackers.errors.nameRequired").max(60),
    /** No space id: which space a connection writes into is the list's answer,
     *  not the caller's. Taking one from the form would let somebody who may
     *  admin one list have issues mirrored into any space on the instance. */
    listId: z.string().uuid(),
    /** A Linear team key, or a JQL string. Bounded, and otherwise the provider's
     *  business - Polaris does not parse somebody else's query language. */
    query: z.string().trim().max(500).default(""),
    config: z.record(z.string().max(40), z.string().trim().max(200)).default({}),
    secret: z.string().trim().max(400).default(""),
    pushStatus: z.boolean().default(false)
});

/** The spaces and lists a connection can be pointed at: the ones this account can
 *  actually write to, not the ones it can see. */
export async function trackerTargetsAction(): Promise<{
    spaces: { id: string; name: string; lists: { id: string; name: string }[] }[];
}> {
    const user = await requirePermission("tasks.manage");
    const scope = await access.visibleScope({ id: user.id, isAdmin: Boolean(user.isAdmin) });
    const spaces = await prisma.taskSpace.findMany({
        where: { id: { in: access.scopeSpaceIds(scope) }, archived: false },
        select: {
            id: true,
            name: true,
            lists: {
                where: { archived: false },
                select: { id: true, name: true },
                orderBy: { order: "asc" }
            }
        },
        orderBy: { order: "asc" }
    });
    return { spaces };
}

export async function listTrackersAction(): Promise<trackers.TrackerView[]> {
    const user = await requirePermission("tasks.manage");
    return trackers.listTrackers(user.id);
}

export async function saveTrackerAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("tasks.manage");
    const parsed = saveSchema.safeParse(input);
    const t = await getTranslations("tasks");
    if (!parsed.success) {
        const message = parsed.error.issues[0]?.message;
        return { error: message === "trackers.errors.nameRequired" ? t(message) : t("trackers.errors.checkForm") };
    }
    const value = parsed.data;

    // Reaching a space is not permission to fill it with somebody else's issues.
    let spaceId: string;
    try {
        const list = await access.requireList(
            { id: user.id, isAdmin: Boolean(user.isAdmin) },
            value.listId,
            "admin"
        );
        spaceId = list.spaceId;
    } catch {
        return { error: t("trackers.errors.listNotYours") };
    }

    // Every field the provider says it needs, present. A Jira with no site is a
    // connection that fails on its first call with a worse message than this.
    for (const field of core.ISSUE_TRACKER_FIELDS[value.provider]) {
        if (field.secret) {
            if (!value.id && !value.secret)
                return { error: t("trackers.errors.fieldRequired", { field: t(`trackers.fields.${field.key}.label` as Parameters<typeof t>[0]) }) };
            continue;
        }
        if (!value.config[field.key]?.trim())
            return { error: t("trackers.errors.fieldRequired", { field: t(`trackers.fields.${field.key}.label` as Parameters<typeof t>[0]) }) };
    }

    const config = { ...value.config };
    // The one field that becomes an address this server calls. Normalised to the
    // single form everything below stores and reads, then checked: a site is a
    // hostname, and anything else is a way to point Polaris at its own network.
    if (value.provider === "jira") {
        config.site = core.normalizeTrackerSite(config.site ?? "");
        if (!core.isTrackerSite(config.site)) {
            return {
                error: t("trackers.errors.notJiraSite")
            };
        }
    }

    try {
        await trackers.saveTracker(user.id, { ...value, spaceId, config });
    } catch (error) {
        return { error: error instanceof Error ? error.message : t("trackers.errors.notSaved") };
    }
    revalidatePath(TRACKERS_PATH);
    return {};
}

export async function checkTrackerAction(
    trackerId: string
): Promise<{ ok: boolean; detail: string }> {
    const user = await requirePermission("tasks.manage");
    const result = await trackers.checkTracker(user.id, trackerId);
    return { ok: result.ok, detail: trackerSentence(await getTranslations("tasks"), result.detail) };
}

export async function syncTrackerAction(
    trackerId: string
): Promise<{ added?: number; updated?: number; error?: string }> {
    const user = await requirePermission("tasks.manage");
    const owned = await prisma.taskTracker.findFirst({
        where: { id: trackerId, ownerId: user.id },
        select: { id: true }
    });
    const t = await getTranslations("tasks");
    if (!owned) return { error: t("trackers.reasons.notYours") };
    const result = await syncTracker(trackerId);
    revalidatePath(TRACKERS_PATH);
    return {
        added: result.added,
        updated: result.updated,
        ...(result.error ? { error: trackerSentence(t, result.error) } : {})
    };
}

export async function setTrackerEnabledAction(
    trackerId: string,
    enabled: boolean
): Promise<{ error?: string }> {
    const user = await requirePermission("tasks.manage");
    await trackers.setTrackerEnabled(user.id, trackerId, enabled);
    revalidatePath(TRACKERS_PATH);
    return {};
}

export async function deleteTrackerAction(trackerId: string): Promise<{ error?: string }> {
    const user = await requirePermission("tasks.manage");
    await trackers.deleteTracker(user.id, trackerId);
    revalidatePath(TRACKERS_PATH);
    return {};
}
