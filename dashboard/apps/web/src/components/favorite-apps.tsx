"use client";

/**
 * The apps somebody chose as favorites and the order they arranged the app menu
 * in, shared by everything that draws them: the app menu, the Overview's rail
 * and the dialog that arranges them.
 *
 * One store rather than a copy each, so a star pressed in the menu moves the
 * rail on the same frame. Every change is optimistic - drawn at once, saved
 * whole, and put back with a note if the server refuses it. Both lists are sent
 * whole so two quick changes cannot interleave into lists neither meant, and a
 * change that leaves them as they were sends nothing at all.
 *
 * It also holds whether the app menu is open, so the rail's "More apps" entry
 * can open the menu that lives in the top bar.
 */

import { useToast } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { arrangeApps, sameOrder, type LauncherPrefs } from "@/lib/app-launcher";
import { saveFavoriteAppsAction } from "@/app/(app)/app-launcher-actions";
import { FavoriteAppsContext, type FavoriteApps } from "@/components/favorite-apps-context";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** How long to wait for a closing drawer before opening the menu anyway. */
const DRAWER_WAIT_FRAMES = 60;

const NO_ORDER: readonly string[] = [];

function samePrefs(left: LauncherPrefs, right: LauncherPrefs): boolean {
    return sameOrder(left.favorites, right.favorites) && sameOrder(left.order, right.order);
}

export function FavoriteAppsProvider({
    initial,
    initialOrder = NO_ORDER,
    children
}: {
    /** The stored favorites, in order. */
    initial: readonly string[];
    /** The stored order of the app menu; empty when it was never arranged. */
    initialOrder?: readonly string[];
    children: ReactNode;
}) {
    const toast = useToast();
    const t = useTranslations("nav");
    const seed: LauncherPrefs = { favorites: initial, order: initialOrder };
    const [prefs, setPrefs] = useState<LauncherPrefs>(seed);
    const [launcherOpen, setLauncherOpen] = useState(false);
    // The lists as of the latest change, read synchronously by the next one: two
    // clicks in one frame must each start from what the other left.
    const latest = useRef<LauncherPrefs>(seed);
    // The lists the server last accepted: a failed save returns here, never to
    // an optimistic list that was not saved either.
    const confirmed = useRef<LauncherPrefs>(seed);

    // A server render that brings different lists (another device saved them)
    // replaces these.
    const initialKey = JSON.stringify([initial, initialOrder]);
    useEffect(() => {
        const [favorites, order] = JSON.parse(initialKey) as [string[], string[]];
        const next: LauncherPrefs = { favorites, order };
        latest.current = next;
        confirmed.current = next;
        setPrefs(next);
    }, [initialKey]);

    const save = useCallback(
        (next: LauncherPrefs) => {
            if (samePrefs(latest.current, next)) return;
            latest.current = next;
            setPrefs(next);
            // Only undone while nothing newer has replaced it: a later change the
            // reader made since is theirs, is saved whole, and reports for itself.
            const rollback = (message: string) => {
                if (latest.current !== next) return;
                latest.current = confirmed.current;
                setPrefs(confirmed.current);
                toast.show({ title: message });
            };
            void saveFavoriteAppsAction({ favorites: [...next.favorites], order: [...next.order] })
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
            favorites: prefs.favorites,
            order: prefs.order,
            toggle: (appId) => {
                const current = latest.current;
                save({
                    ...current,
                    favorites: current.favorites.includes(appId)
                        ? current.favorites.filter((id) => id !== appId)
                        : [...current.favorites, appId]
                });
            },
            arrangeApps: (visible) =>
                save({ ...latest.current, order: arrangeApps(latest.current.order, visible) }),
            resetOrder: () => save({ ...latest.current, order: [] }),
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
        [prefs, launcherOpen, save]
    );

    return <FavoriteAppsContext.Provider value={value}>{children}</FavoriteAppsContext.Provider>;
}
