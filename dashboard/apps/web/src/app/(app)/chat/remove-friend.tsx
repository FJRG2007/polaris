"use client";

/**
 * Removing a friend from wherever their name is in Chat.
 *
 * The conversation list and every person's menu offered Block and Report, and
 * the lighter of the three - no longer being friends - was only on the Friends
 * screen and the profile page. It is asked first, in the app's own dialog,
 * because it takes away what they could see of you and a slip on a menu row is
 * easy. The rail is asked again afterwards so every menu stops offering it.
 */

import { useCallback } from "react";
import { useChat } from "./chat-context";
import { runAction } from "@/lib/run-action";
import { useConfirm } from "@/components/confirm-dialog";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { removeFriendAction } from "@/app/(app)/account/privacy/actions";

export interface FriendToRemove {
    readonly id: string;
    readonly name: string;
}

/**
 * The ask and the element that draws it. Mount the element outside any menu: a
 * menu closes on the item that opens the dialog, and a dialog mounted inside it
 * goes with it.
 */
export function useRemoveFriend(
    onError: (message: string) => void
): [(person: FriendToRemove) => Promise<void>, React.ReactNode] {
    const t = useTranslations("chat");
    const { refresh } = useChat();
    const [confirm, element] = useConfirm();

    const ask = useCallback(
        async (person: FriendToRemove): Promise<void> => {
            const sure = await confirm({
                title: t("removeFriend.title", { name: person.name }),
                description: t("removeFriend.description"),
                confirmLabel: t("removeFriend.confirm"),
                danger: true
            });
            if (!sure) return;
            const result = await runAction(() => removeFriendAction(person.id), onError);
            if (!result) return;
            if (result.error) {
                onError(result.error);
                return;
            }
            refresh();
        },
        [confirm, onError, refresh, t]
    );

    return [ask, element];
}
