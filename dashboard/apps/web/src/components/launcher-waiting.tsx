"use client";

/**
 * Marking what an app has waiting as read, from the app menu, without opening
 * the app.
 *
 * The menu lists apps and nothing else: what is waiting is the count on each
 * tile, and a tile with something it may dismiss carries a small "mark read" on
 * its corner. The foot of the menu has "mark everything read". A mark clears
 * the badge and nothing inside the app - see `lib/launcher-waiting`.
 *
 * Which tiles may be marked is the badges' answer, from the first paint: every
 * app whose badge is up offers the mark, and a mark takes the whole badge down.
 * The waiting route, asked when the menu opens, only refines that - an app
 * whose entries are all faults no mark dismisses loses the mark, and the part
 * of a badge such a fault holds stays up. The last answer is kept for the
 * page's life and used at once on the next open, then replaced if it changed.
 *
 * A mark moves the badge at once and is put back if the server refuses it, with
 * a toast saying so.
 */

import { CheckCheck } from "lucide-react";
import { useAdminRecount } from "@/components/admin-waiting";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useToast, type AppTileAction, type PolarisApp } from "@polaris/ui";
import { useAppUnread, useNudgeAppUnread, useServerUnread } from "@/components/app-unread";
import { useHoldConversationNotices } from "@/components/notifications/notifications-provider";
import { markLauncherReadAction } from "@/app/(app)/launcher-waiting-actions";
import {
    launcherWaitingSchema,
    LAUNCHER_WAITING_APPS,
    markableApps,
    undismissable,
    withoutAll,
    withoutApp,
    type LauncherWaiting,
    type LauncherWaitingApp
} from "@/lib/launcher-waiting";

const WAITING_PATH = "/api/launcher/waiting";

/** The last answer, for the page's life: used at once on the next open. */
let lastKnown: LauncherWaiting | null = null;

function isWaitingApp(id: string): id is LauncherWaitingApp {
    return (LAUNCHER_WAITING_APPS as readonly string[]).includes(id);
}

export interface LauncherMarks {
    /** The "mark read" a tile carries, or null for one with nothing to mark. */
    readonly tileAction: (app: PolarisApp) => AppTileAction | null;
    /**
     * The same mark for any list that draws an app by its id - the Overview's
     * rail, a right click on an app. `short` names it without the app, for a
     * menu that is already about one app. Null with nothing to mark.
     */
    readonly markAction: (appId: string, appLabel: string, short?: boolean) => AppTileAction | null;
    /** Whether any app has something to mark, for "mark everything read". */
    readonly anything: boolean;
    readonly markAll: () => void;
}

export function useLauncherMarks(
    /** Whether the menu is open: what is waiting is asked for when it opens. */
    open: boolean
): LauncherMarks {
    const t = useTranslations("nav");
    const toast = useToast();
    const server = useServerUnread();
    // What the badges show now, this browser's marks included: what a mark is
    // offered on, and how far it takes each badge down.
    const shown = useAppUnread();
    const nudge = useNudgeAppUnread();
    const holdNotices = useHoldConversationNotices();
    const recountAdmin = useAdminRecount();
    const [waiting, setWaiting] = useState<LauncherWaiting | null>(lastKnown);
    const latest = useRef<LauncherWaiting | null>(lastKnown);
    // Marks still on their way: an answer read before they land would put back
    // what they took away, so it is set aside and asked for again after.
    const marking = useRef(0);
    const missed = useRef(false);

    const apply = useCallback((next: LauncherWaiting) => {
        latest.current = next;
        lastKnown = next;
        setWaiting(next);
    }, []);

    const refresh = useCallback(
        (signal?: AbortSignal) =>
            fetch(WAITING_PATH, { cache: "no-store", signal })
                .then((response) => (response.ok ? response.json() : null))
                .then((body) => {
                    const parsed = launcherWaitingSchema.safeParse(body);
                    if (!parsed.success) return;
                    missed.current = marking.current > 0;
                    if (!missed.current) apply(parsed.data);
                })
                .catch(() => {
                    // Left as it was: the badges still say what is waiting, and
                    // the next open asks again.
                }),
        [apply]
    );

    // On opening, and again while open whenever a count moves on the server -
    // something arrived, or was read somewhere else. Not on a mark made here,
    // which moves the badge before the server has it.
    const counts = LAUNCHER_WAITING_APPS.map((app) => server[app] ?? 0).join(",");
    useEffect(() => {
        if (!open) return;
        const controller = new AbortController();
        void refresh(controller.signal);
        return () => controller.abort();
    }, [open, counts, refresh]);

    const mark = useCallback(
        async (app: LauncherWaitingApp | null) => {
            const before = latest.current;
            const touched = app ? [app] : [...markableApps(shown, before)];
            if (touched.length === 0) return;
            // By the badge, not by the route: the route may not have answered,
            // and a badge is what the reader is marking. Only what the route
            // says no mark dismisses stays on it.
            const by = (one: LauncherWaitingApp) =>
                -Math.max(0, (shown[one] ?? 0) - undismissable(before, one));
            const after = before ? (app ? withoutApp(before, app) : withoutAll(before)) : null;
            if (after) apply(after);
            // Every badge moves by this browser's overlay, Mail's included -
            // never on Mail's own ledger, which the rail inside Mail reads: the
            // mail is still unread there. The bell's notices about the
            // conversations listed here go too, which the server reads in the
            // same action.
            const notices = touched.includes("mail")
                ? holdNotices(
                      before?.groups
                          .find((group) => group.app === "mail")
                          ?.items.map((item) => item.id) ?? []
                  )
                : null;
            const undo = new Map(touched.map((one) => [one, nudge(one, by(one))]));
            marking.current += 1;
            const result = await markLauncherReadAction(
                app ? { scope: "app", app } : { scope: "all" }
            )
                .catch(() => ({ error: t("waitingList.errors.notMarked") }))
                .finally(() => {
                    marking.current -= 1;
                });
            if (result.error) {
                for (const one of undo.values()) one();
                notices?.abandon();
                if (before && latest.current === after) apply(before);
                toast.show({ title: result.error });
                void refresh();
                return;
            }
            notices?.settle();
            const admin = undo.get("admin");
            if (admin) {
                void recountAdmin().then((counted) => {
                    if (counted) admin();
                });
            }
            if (marking.current === 0 && missed.current) {
                missed.current = false;
                void refresh();
            }
        },
        [apply, holdNotices, nudge, recountAdmin, refresh, shown, t, toast]
    );

    const markable = markableApps(shown, waiting);
    const markAction = (appId: string, appLabel: string, short = false): AppTileAction | null => {
        if (!isWaitingApp(appId) || !markable.has(appId)) return null;
        const seen = appId === "admin";
        return {
            label: short
                ? t(seen ? "switcher.markSeen" : "switcher.markRead")
                : t(seen ? "waitingList.markAllSeen" : "waitingList.markAllRead", {
                      app: appLabel
                  }),
            icon: <CheckCheck aria-hidden="true" />,
            onSelect: () => void mark(appId)
        };
    };
    const tileAction = (app: PolarisApp) => markAction(app.id, app.label);

    return {
        tileAction,
        markAction,
        anything: markable.size > 0,
        markAll: () => void mark(null)
    };
}
