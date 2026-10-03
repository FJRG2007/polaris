"use client";

/**
 * The apps somebody chose as favorites, shared by everything that draws them:
 * the app menu, the Overview's rail and the dialog that arranges them.
 *
 * One store rather than a copy each, so a star pressed in the menu moves the
 * rail on the same frame. Every change is optimistic - drawn at once, saved
 * whole, and put back with a note if the server refuses it. The list is sent
 * whole so two quick changes cannot interleave into a list neither meant, and a
 * change that leaves the order as it was sends nothing at all.
 *
 * It also holds whether the app menu is open, so the rail's "More apps" entry
 * can open the menu that lives in the top bar.
 */

import { useToast } from "@polaris/ui";
import { arrangeFavorites, sameOrder } from "@/lib/app-launcher";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { saveFavoriteAppsAction } from "@/app/(app)/app-launcher-actions";
import { FavoriteAppsContext, type FavoriteApps } from "@/components/favorite-apps-context";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** How long to wait for a closing drawer before opening the menu anyway. */
const DRAWER_WAIT_FRAMES = 60;

export function FavoriteAppsProvider({
    initial,
    children
}: {
    initial: readonly string[];
    children: ReactNode;
}) {
    const toast = useToast();
    const t = useTranslations("nav");
    const [favorites, setFavorites] = useState<readonly string[]>(initial);
    const [launcherOpen, setLauncherOpen] = useState(false);
    // The list as of the latest change, read synchronously by the next one: two
    // clicks in one frame must each start from what the other left.
    const latest = useRef<readonly string[]>(initial);
    // The list the server last accepted: a failed save returns here, never to an
    // optimistic list that was not saved either.
    const confirmed = useRef<readonly string[]>(initial);

    // A server render that brings a different list (another device saved one)
    // replaces this one.
    const initialKey = initial.join("\n");
    useEffect(() => {
        const next = initialKey ? initialKey.split("\n") : [];
        latest.current = next;
        confirmed.current = next;
        setFavorites(next);
    }, [initialKey]);

    const save = useCallback(
        (next: readonly string[]) => {
            const previous = latest.current;
            if (sameOrder(previous, next)) return;
            latest.current = next;
            setFavorites(next);
            // Only undone while nothing newer has replaced it: a later change the
            // reader made since is theirs, is saved whole, and reports for itself.
            const rollback = (message: string) => {
                if (!sameOrder(latest.current, next)) return;
                latest.current = confirmed.current;
                setFavorites(confirmed.current);
                toast.show({ title: message });
            };
            void saveFavoriteAppsAction([...next])
                .then((answer) => {
                    if (answer.error) rollback(answer.error);
                    else confirmed.current = next;
                })
                .catch(() => rollback(t("switcher.saveFailed")));
        },
        [t, toast]
    );

    const value = useMemo<FavoriteApps>(
        () => ({
            favorites,
            toggle: (appId) => {
                const current = latest.current;
                save(
                    current.includes(appId)
                        ? current.filter((id) => id !== appId)
                        : [...current, appId]
                );
            },
            arrange: (visible) => save(arrangeFavorites(latest.current, visible)),
            launcherOpen,
            setLauncherOpen,
            openLauncher: () => {
                let frames = 0;
                const wait = () => {
                    const drawer = document.querySelector('[role="dialog"][data-state="open"]');
                    if (drawer && frames++ < DRAWER_WAIT_FRAMES) requestAnimationFrame(wait);
                    else setLauncherOpen(true);
                };
                requestAnimationFrame(wait);
            }
        }),
        [favorites, launcherOpen, save]
    );

    return <FavoriteAppsContext.Provider value={value}>{children}</FavoriteAppsContext.Provider>;
}
