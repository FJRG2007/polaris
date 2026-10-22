/**
 * The bell for a Polar chat that answered while the person was elsewhere.
 *
 * Only a run no screen was following is announced: whoever watched it end
 * already saw it, and one the person stopped needs no telling. The words are
 * the person's language, read when the bell is written (`chat/text.ts` does
 * the same for a missed call).
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

/** What the bell says, by how the run ended. */
export function runNotice(
    t: NamespaceTranslator<"polar">,
    state: Exclude<PolarRunEnd["state"], "stopped">,
    title: string
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
            body: t("notices.failedBody"),
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

/** Sends the bell for a run that ended unwatched; never throws. */
export async function noticePolarRunEnd(end: PolarRunEnd): Promise<void> {
    if (end.watched || end.state === "stopped") return;
    try {
        const thread = await prisma.polarThread.findFirst({
            where: { id: end.threadId, userId: end.userId },
            select: { title: true, temporary: true }
        });
        // A temporary chat is gone once it is left; there is nothing to open.
        if (!thread || thread.temporary) return;
        const notice = runNotice(await wordsFor(end.userId), end.state, thread.title);
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
