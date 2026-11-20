"use client";

/**
 * Muting apps from the app menu's right click. A change is drawn at once and
 * put back with a note if the server refuses it; the saved holds the server
 * answers with replace the guess, since they carry its clock's end time.
 */

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useToast } from "@polaris/ui";
import type { NotificationHolds, NotificationMuteDuration } from "@polaris/core";
import { applyAppMute, applyAppMuteMentions } from "@/lib/app-mutes";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { setAppMuteAction, setAppMuteMentionsAction } from "@/app/(app)/app-launcher-actions";
import { AppMutesContext } from "@/components/app-mutes-context";

export function AppMutesProvider({
    initial,
    children
}: {
    initial: NotificationHolds;
    children: ReactNode;
}) {
    const toast = useToast();
    const t = useTranslations("nav");
    const [holds, setHolds] = useState<NotificationHolds>(initial);
    const latest = useRef(holds);

    // Drawn at once; the saved holds the server answers with replace the guess.
    const save = useCallback(
        (
            next: NotificationHolds,
            before: NotificationHolds,
            send: () => Promise<{ holds?: NotificationHolds; error?: string }>
        ) => {
            latest.current = next;
            setHolds(next);
            const rollback = (message: string) => {
                if (latest.current !== next) return;
                latest.current = before;
                setHolds(before);
                toast.show({ title: message });
            };
            void send()
                .then((answer) => {
                    if (answer.error || !answer.holds) {
                        rollback(answer.error ?? t("switcher.muteFailed"));
                        return;
                    }
                    if (latest.current !== next) return;
                    latest.current = answer.holds;
                    setHolds(answer.holds);
                })
                .catch(() => rollback(t("switcher.muteFailed")));
        },
        [t, toast]
    );

    const mute = useCallback(
        (appId: string, duration: NotificationMuteDuration | null) => {
            const before = latest.current;
            save(applyAppMute(before, appId, duration, new Date()), before, () =>
                setAppMuteAction({ appId, duration })
            );
        },
        [save]
    );

    const muteMentions = useCallback(
        (appId: string, on: boolean) => {
            const before = latest.current;
            save(applyAppMuteMentions(before, appId, on, new Date()), before, () =>
                setAppMuteMentionsAction({ appId, on })
            );
        },
        [save]
    );

    const value = useMemo(() => ({ holds, mute, muteMentions }), [holds, mute, muteMentions]);
    return <AppMutesContext.Provider value={value}>{children}</AppMutesContext.Provider>;
}
