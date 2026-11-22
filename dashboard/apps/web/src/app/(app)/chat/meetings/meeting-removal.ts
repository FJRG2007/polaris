"use client";

/**
 * The words for closing a meeting, by what closing it means right now: ended
 * when people are in it, cancelled when it is in the diary, deleted otherwise.
 * One place, so the list and the room never name the same act differently.
 */

import { useTranslations } from "@/components/i18n/i18n-provider";
import type { MeetingRemoval } from "@/lib/chat/meeting-list";

export interface RemovalWords {
    /** The menu item and the confirm button. */
    readonly action: string;
    /** The confirm dialog's question. */
    readonly title: string;
    /** What happens, under the question. */
    readonly body: string;
}

export function useRemovalWords(): (removal: MeetingRemoval, name: string) => RemovalWords {
    const t = useTranslations("chat");
    return (removal, name) => {
        if (removal === "end") {
            return {
                action: t("meetings.removal.end.action"),
                title: t("meetings.removal.end.title", { name }),
                body: t("meetings.removal.end.body")
            };
        }
        if (removal === "cancel") {
            return {
                action: t("meetings.removal.cancel.action"),
                title: t("meetings.removal.cancel.title", { name }),
                body: t("meetings.removal.cancel.body")
            };
        }
        return {
            action: t("meetings.removal.delete.action"),
            title: t("meetings.removal.delete.title", { name }),
            body: t("meetings.removal.delete.body")
        };
    };
}
