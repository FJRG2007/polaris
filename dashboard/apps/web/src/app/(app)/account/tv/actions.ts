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
import { listTvs, requestTvUpdates, type TvRow } from "@/lib/tv/update-requests";

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
