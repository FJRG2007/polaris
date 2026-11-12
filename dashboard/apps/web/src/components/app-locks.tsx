"use client";

/**
 * The apps this account keeps behind its PIN, for the app menu's right click.
 * A change is drawn at once and put back with a note if the server refuses it;
 * the server is what keeps a locked app shut (see `app-lock-service`).
 */

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { setAppLockAction } from "@/app/(app)/app-launcher-actions";
import { AppLocksContext } from "@/components/app-locks-context";

export function AppLocksProvider({
    initial,
    hasPin,
    children
}: {
    initial: readonly string[];
    hasPin: boolean;
    children: ReactNode;
}) {
    const toast = useToast();
    const router = useRouter();
    const t = useTranslations("nav");
    const [locked, setLocked] = useState<readonly string[]>(initial);
    const latest = useRef(locked);

    const toggleLock = useCallback(
        (appId: string) => {
            const before = latest.current;
            const lock = !before.includes(appId);
            const next = lock ? [...before, appId] : before.filter((id) => id !== appId);
            latest.current = next;
            setLocked(next);
            const rollback = (message: string) => {
                if (latest.current !== next) return;
                latest.current = before;
                setLocked(before);
                toast.show({ title: message });
            };
            void setAppLockAction({ appId, locked: lock })
                .then((answer) => {
                    if (answer.error) rollback(answer.error);
                })
                .catch(() => rollback(t("switcher.lockFailed")));
        },
        [t, toast]
    );

    const value = useMemo(
        () => ({ locked, hasPin, toggleLock, setUpPin: () => router.push("/account/security") }),
        [locked, hasPin, toggleLock, router]
    );
    return <AppLocksContext.Provider value={value}>{children}</AppLocksContext.Provider>;
}
