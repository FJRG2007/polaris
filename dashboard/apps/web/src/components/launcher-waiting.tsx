"use client";

/**
 * Marking what an app has waiting as read, from the app menu, without opening
 * the app.
 *
 * The menu lists apps and nothing else: what is waiting is the count on each
 * tile, and a tile with something it may dismiss carries a small "mark read" on
 * its corner. The foot of the menu has "mark everything read". What "read"
 * means is the app's own - see `lib/launcher-waiting`.
 *
 * Which tiles may be marked, and by how much a mark moves each badge, comes from
 * the waiting route, asked when the menu opens: Management's badge counts a
 * fault that no mark dismisses, so the badge alone cannot say. The last answer
 * is kept for the page's life and used at once on the next open, then replaced
 * if it changed.
 *
 * A mark moves the badge at once and is put back if the server refuses it, with
 * a toast saying so.
 */

import { CheckCheck } from "lucide-react";
import { useAdminRecount } from "@/components/admin-waiting";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useToast, type AppTileAction, type PolarisApp } from "@polaris/ui";
import { useNudgeAppUnread, useServerUnread } from "@/components/app-unread";
import { markLauncherReadAction } from "@/app/(app)/launcher-waiting-actions";
import {
    badgeDelta,
    launcherWaitingSchema,
    LAUNCHER_WAITING_APPS,
    markableApps,
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
    const nudge = useNudgeAppUnread();
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
            if (!before) return;
            const after = app ? withoutApp(before, app) : withoutAll(before);
            const touched = app ? [app] : [...markableApps(before)];
            apply(after);
            const undo = touched.map((one) => nudge(one, badgeDelta(before, after, one)));
            marking.current += 1;
            const result = await markLauncherReadAction(
                app ? { scope: "app", app } : { scope: "all" }
            )
                .catch(() => ({ error: t("waitingList.errors.notMarked") }))
                .finally(() => {
                    marking.current -= 1;
                });
            if (result.error) {
                for (const one of undo) one();
                if (latest.current === after) apply(before);
                toast.show({ title: result.error });
                void refresh();
                return;
            }
            if (touched.includes("admin")) recountAdmin();
            if (marking.current === 0 && missed.current) {
                missed.current = false;
                void refresh();
            }
        },
        [apply, nudge, recountAdmin, refresh, t, toast]
    );

    const markable = markableApps(waiting);
    const tileAction = (app: PolarisApp): AppTileAction | null => {
        if (!isWaitingApp(app.id) || !markable.has(app.id)) return null;
        const id = app.id;
        return {
            label: t(id === "admin" ? "waitingList.markAllSeen" : "waitingList.markAllRead", {
                app: app.label
            }),
            icon: <CheckCheck aria-hidden="true" />,
            onSelect: () => void mark(id)
        };
    };

    return { tileAction, anything: markable.size > 0, markAll: () => void mark(null) };
}
