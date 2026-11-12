"use client";

/**
 * Muting apps from the app menu's right click. A change is drawn at once and
 * put back with a note if the server refuses it; the saved holds the server
 * answers with replace the guess, since they carry its clock's end time.
 */

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useToast } from "@polaris/ui";
import type { NotificationHolds, NotificationMuteDuration } from "@polaris/core";
import { applyAppMute } from "@/lib/app-mutes";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { setAppMuteAction } from "@/app/(app)/app-launcher-actions";
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

    const mute = useCallback(
        (appId: string, duration: NotificationMuteDuration | null) => {
            const before = latest.current;
            const next = applyAppMute(before, appId, duration, new Date());
            latest.current = next;
            setHolds(next);
            const rollback = (message: string) => {
                if (latest.current !== next) return;
                latest.current = before;
                setHolds(before);
                toast.show({ title: message });
            };
            void setAppMuteAction({ appId, duration })
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

    const value = useMemo(() => ({ holds, mute }), [holds, mute]);
    return <AppMutesContext.Provider value={value}>{children}</AppMutesContext.Provider>;
}
