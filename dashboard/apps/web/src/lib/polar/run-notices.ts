/**
 * The bell for a Polar chat that answered while the person was elsewhere.
 *
 * Only a run no screen was following is announced: whoever watched it end
 * already saw it, and one the person stopped needs no telling. The words are
 * the person's language, read when the bell is written (`chat/text.ts` does
 * the same for a missed call).
 *
 * A failed run says why in the bell itself - which provider and model did not
 * answer, and what to do - rather than sending the reader to the chat to find
 * out. And once the same chat answers afterwards (a retry, another model), the
 * failure is old news: its bell is marked read.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import type { PolarRunEnd } from "@/lib/polar/runs";
import { translatorFor } from "@/lib/i18n/translate";
import { notify } from "@/lib/notifications/dispatch";
import type { NamespaceTranslator } from "@/lib/i18n/types";

type Notice = {
    title: string;
    body: string;
    level: "info" | "warning" | "danger";
    actionRequired: boolean;
};

/** The failure kinds the bell has its own sentence for. */
const FAILURE_KINDS = new Set(["key", "credit", "rate", "down", "model"]);

/** Why a failed run stopped, in a sentence: the provider's failure when the
 *  answer carried one, otherwise the plain fact that it ended early. Pure. */
export function failedBody(
    t: NamespaceTranslator<"polar">,
    failure: PolarRunEnd["failure"],
    model: string | null
): string {
    if (failure?.code !== "provider") return t("notices.failedBody");
    const kind = failure.kind && FAILURE_KINDS.has(failure.kind) ? failure.kind : "other";
    const where = [failure.provider, model].filter(Boolean).join(", ");
    return t(`notices.failed.${kind as "other"}`, { where: where || "?" });
}

/** What the bell says, by how the run ended. */
export function runNotice(
    t: NamespaceTranslator<"polar">,
    state: Exclude<PolarRunEnd["state"], "stopped">,
    title: string,
    failure: PolarRunEnd["failure"] = null,
    model: string | null = null
): Notice {
    if (state === "approval")
        return {
            title: t("notices.waitingTitle", { title }),
            body: t("notices.waitingBody"),
            level: "warning",
            actionRequired: true
        };
    if (state === "failed")
        return {
            title: t("notices.failedTitle", { title }),
            body: failedBody(t, failure, model),
            level: "danger",
            actionRequired: false
        };
    return {
        title: t("notices.answeredTitle", { title }),
        body: t("notices.answeredBody"),
        level: "info",
        actionRequired: false
    };
}

async function wordsFor(userId: string): Promise<NamespaceTranslator<"polar">> {
    try {
        const { getUserLocale } = await import("@/lib/i18n/locale-service");
        return translatorFor(await getUserLocale(userId), "polar");
    } catch {
        return translatorFor(core.DEFAULT_LOCALE, "polar");
    }
}

/** What a failed run's bell is stored with, so a later answer can find it. */
function failedMark(threadId: string): string {
    return `"threadId":${JSON.stringify(threadId)},"state":"failed"`;
}

/** Marks read the bells this chat's failed runs left, now that it answered. */
export async function withdrawFailedNotices(userId: string, threadId: string): Promise<number> {
    const { count } = await prisma.notification.updateMany({
        where: {
            userId,
            type: "polar.chatReady",
            readAt: null,
            metadata: { contains: failedMark(threadId) }
        },
        data: { readAt: new Date() }
    });
    return count;
}

/**
 * Sends the bell for a run that ended unwatched, and withdraws an older
 * failure's once the chat answers; never throws. `model` names the model the
 * run used, for a failure's sentence.
 */
export async function noticePolarRunEnd(
    end: PolarRunEnd,
    model: string | null = null
): Promise<void> {
    if (end.state === "done" || end.state === "approval") {
        await withdrawFailedNotices(end.userId, end.threadId).catch((error: unknown) =>
            console.error("polar: could not withdraw a failed chat's notice", error)
        );
    }
    if (end.watched || end.state === "stopped") return;
    try {
        const thread = await prisma.polarThread.findFirst({
            where: { id: end.threadId, userId: end.userId },
            select: { title: true, temporary: true }
        });
        // A temporary chat is gone once it is left; there is nothing to open.
        if (!thread || thread.temporary) return;
        const notice = runNotice(
            await wordsFor(end.userId),
            end.state,
            thread.title,
            end.failure ?? null,
            model
        );
        await notify({
            userId: end.userId,
            event: "polar.chatReady",
            ...notice,
            href: `/polar?thread=${end.threadId}`,
            metadata: { threadId: end.threadId, state: end.state }
        });
    } catch (error) {
        console.error("polar: could not send the finished-chat notice", error);
    }
}
