"use server";

/**
 * Updating connected TVs from /account/tv. The same check as the page itself:
 * a signed-in account, acting only on its own TVs.
 */

import { z } from "zod";
import { requireUser } from "@/lib/session";
import { tvReleaseInfo } from "@/lib/tv/release";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { getTranslations } from "@/lib/i18n/request";
import { seenDevices } from "@/lib/dns-blocker/insights";
import { DnsBlockerRefusal } from "@/lib/dns-blocker/service";
import { reachOf, type TvFilterReach } from "@/lib/tv/filter-reach";
import { listTvs, requestTvUpdates, type TvRow } from "@/lib/tv/update-requests";
import { tvNameSchema } from "@/lib/tv/tv-name";
import { renameTv, setTvBlocking } from "@/lib/tv/preferences";

const LIMIT = 30;
const WINDOW_MS = 60_000;

const targetSchema = z.union([
    z.object({ keyId: z.string().uuid() }),
    z.object({ all: z.literal(true) })
]);

export interface TvUpdatesView {
    readonly tvs: TvRow[];
    /** The newest TV build this instance can serve, or null when none is known. */
    readonly latest: string | null;
}

async function latestVersion(): Promise<string | null> {
    return (await tvReleaseInfo().catch(() => null))?.versionName ?? null;
}

/** The account's TVs and the newest build, for the list and its refreshes. */
export async function tvUpdatesAction(): Promise<TvUpdatesView> {
    const user = await requireUser();
    const [tvs, latest] = await Promise.all([listTvs(user.id), latestVersion()]);
    return { tvs, latest };
}

/** Ask one TV, or all of them, to install the newest build. A TV already asked,
 *  or already on it, is left as it is. */
export async function requestTvUpdateAction(
    target: unknown
): Promise<TvUpdatesView & { error?: string }> {
    const user = await requireUser();
    const t = await getTranslations("account");
    const parsed = targetSchema.safeParse(target);
    const latest = await latestVersion();
    if (!parsed.success || !latest) {
        return {
            tvs: await listTvs(user.id),
            latest,
            error: t(latest ? "tv.updates.errors.notATv" : "tv.updates.errors.noRelease")
        };
    }
    const throttle = await rateLimit(`tv-update:${user.id}`, LIMIT, WINDOW_MS);
    if (!throttle.ok) {
        return { tvs: await listTvs(user.id), latest, error: t("tv.updates.errors.tooMany") };
    }
    const only = "keyId" in parsed.data ? [parsed.data.keyId] : null;
    const queued = await requestTvUpdates(user.id, only, latest);
    for (const keyId of queued) {
        await recordAudit({
            actorId: user.id,
            action: "account.tv.update.requested",
            targetType: "apiKey",
            targetId: keyId,
            metadata: { versionName: latest }
        });
    }
    return { tvs: await listTvs(user.id), latest };
}

const blockingSchema = z.object({ keyId: z.string().uuid(), blocking: z.boolean() });
const renameSchema = z.object({ keyId: z.string().uuid(), name: tvNameSchema });

/** Turn Block ads and trackers on or off for one TV. The TV applies it on its next check-in. */
export async function setTvBlockingAction(
    input: unknown
): Promise<TvUpdatesView & { error?: string }> {
    const user = await requireUser();
    const t = await getTranslations("account");
    const parsed = blockingSchema.safeParse(input);
    const throttle = await rateLimit(`tv-prefs:${user.id}`, LIMIT, WINDOW_MS);
    const refusal = !parsed.success
        ? "tv.updates.errors.notATv"
        : !throttle.ok
          ? "tv.prefs.errors.tooMany"
          : null;
    const changed =
        !refusal && parsed.success
            ? await setTvBlocking(user.id, parsed.data.keyId, parsed.data.blocking)
            : false;
    if (changed && parsed.success) {
        await recordAudit({
            actorId: user.id,
            action: "account.tv.blocking.changed",
            targetType: "apiKey",
            targetId: parsed.data.keyId,
            metadata: { blocking: parsed.data.blocking }
        });
    }
    const [tvs, latest] = await Promise.all([listTvs(user.id), latestVersion()]);
    if (refusal || !changed)
        return { tvs, latest, error: t(refusal ?? "tv.updates.errors.notATv") };
    return { tvs, latest };
}

/** Give one TV a name of its owner's choosing. */
export async function renameTvAction(input: unknown): Promise<TvUpdatesView & { error?: string }> {
    const user = await requireUser();
    const t = await getTranslations("account");
    const parsed = renameSchema.safeParse(input);
    const throttle = await rateLimit(`tv-prefs:${user.id}`, LIMIT, WINDOW_MS);
    const refusal = !parsed.success
        ? "tv.prefs.errors.badName"
        : !throttle.ok
          ? "tv.prefs.errors.tooMany"
          : null;
    const renamed =
        !refusal && parsed.success
            ? await renameTv(user.id, parsed.data.keyId, parsed.data.name)
            : false;
    if (renamed && parsed.success) {
        await recordAudit({
            actorId: user.id,
            action: "account.tv.renamed",
            targetType: "apiKey",
            targetId: parsed.data.keyId,
            metadata: { name: parsed.data.name }
        });
    }
    const [tvs, latest] = await Promise.all([listTvs(user.id), latestVersion()]);
    if (refusal || !renamed)
        return { tvs, latest, error: t(refusal ?? "tv.updates.errors.notATv") };
    return { tvs, latest };
}

/**
 * For each of the account's TVs, whether its lookups reach the Network filter.
 * Only the account's own TVs, and only yes or no: never what they looked up.
 */
export async function tvFilterReachAction(): Promise<Record<string, TvFilterReach>> {
    const user = await requireUser();
    const tvs = await listTvs(user.id);
    let seen: Awaited<ReturnType<typeof seenDevices>> | null = null;
    try {
        seen = await seenDevices("24h");
    } catch (caught) {
        if (!(caught instanceof DnsBlockerRefusal)) {
            console.error("[account/tv] reading the network filter's devices failed", caught);
            return Object.fromEntries(tvs.map((tv) => [tv.id, "unknown" as const]));
        }
    }
    return Object.fromEntries(tvs.map((tv) => [tv.id, reachOf(tv.address, seen)]));
}
