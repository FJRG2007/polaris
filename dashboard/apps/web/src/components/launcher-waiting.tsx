"use client";

/**
 * What each app has waiting, listed in the app menu under the grid.
 *
 * Grouped the way a notification centre groups by app: the app's icon, name and
 * count, then its newest few entries. Each entry opens what it is about and has
 * its own "mark read"; each group has "mark all read". What "read" means is the
 * app's own - see `lib/launcher-waiting`.
 *
 * Asked for when the menu opens, not on every page: the badges already carry the
 * numbers. The last answer is kept for the page's life and drawn at once the
 * next time the menu opens, then replaced if it changed. Until the first answer
 * arrives, each app with a badge gets one placeholder row, shaped like an entry.
 *
 * A mark moves the menu and the badge at once and is put back if the server
 * refuses it, with a toast saying so.
 */

import Link from "next/link";
import { Check, CheckCheck } from "lucide-react";
import { badgeLabel } from "@/lib/notification-badge";
import { useAdminRecount } from "@/components/admin-waiting";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { DropdownMenuItem, useToast, type PolarisApp } from "@polaris/ui";
import { useAppUnread, useNudgeAppUnread, useServerUnread } from "@/components/app-unread";
import { markLauncherReadAction } from "@/app/(app)/launcher-waiting-actions";
import {
    badgeDelta,
    launcherWaitingSchema,
    LAUNCHER_WAITING_APPS,
    withoutApp,
    withoutItem,
    type LauncherWaiting,
    type LauncherWaitingApp,
    type LauncherWaitingItem
} from "@/lib/launcher-waiting";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

const WAITING_PATH = "/api/launcher/waiting";

/** The last answer, for the page's life: drawn at once on the next open. */
let lastKnown: LauncherWaiting | null = null;

const ICON_BUTTON =
    "size-7 shrink-0 justify-center p-0 text-muted-foreground hover:text-foreground focus:text-foreground";

export function LauncherWaitingList({
    open,
    apps
}: {
    /** Whether the menu is open: the list is asked for when it opens. */
    open: boolean;
    /** The apps this reader can open, for each group's icon, name and link. */
    apps: readonly PolarisApp[];
}) {
    const t = useTranslations("nav");
    const toast = useToast();
    const unread = useAppUnread();
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
        async (app: LauncherWaitingApp, id: string | null) => {
            const before = latest.current;
            if (!before) return;
            const after = id ? withoutItem(before, app, id) : withoutApp(before, app);
            const delta = badgeDelta(before, after, app);
            apply(after);
            const undo = nudge(app, delta);
            marking.current += 1;
            const result = await markLauncherReadAction(
                id ? { scope: "item", app, id } : { scope: "app", app }
            )
                .catch(() => ({ error: t("waitingList.errors.notMarked") }))
                .finally(() => {
                    marking.current -= 1;
                });
            if (result.error) {
                undo();
                if (latest.current === after) apply(before);
                toast.show({ title: result.error });
                void refresh();
                return;
            }
            if (app === "admin") recountAdmin();
            if (marking.current === 0 && missed.current) {
                missed.current = false;
                void refresh();
            }
        },
        [apply, nudge, recountAdmin, refresh, t, toast]
    );

    const byId = new Map(apps.map((app) => [app.id, app]));
    const reachable = LAUNCHER_WAITING_APPS.filter((app) => byId.has(app));

    // Not asked yet: one placeholder per app whose badge says something is
    // there, so the menu does not jump when the answer lands.
    if (!waiting) {
        const pending = reachable.filter((app) => (unread[app] ?? 0) > 0);
        if (pending.length === 0) return null;
        return (
            <section
                aria-busy="true"
                aria-label={t("waitingList.title")}
                className="mt-2 border-t border-border pt-2"
            >
                {pending.map((app) => (
                    <div key={app} className="flex items-center gap-2 px-2 py-2">
                        <span className="size-5 shrink-0 animate-pulse rounded bg-muted" />
                        <span className="h-3 w-2/3 animate-pulse rounded bg-muted" />
                    </div>
                ))}
            </section>
        );
    }

    const groups = waiting.groups.filter((group) => byId.has(group.app));
    if (groups.length === 0) return null;

    return (
        <section aria-label={t("waitingList.title")} className="mt-2 border-t border-border pt-1">
            {groups.map((group) => {
                const app = byId.get(group.app);
                if (!app) return null;
                const Icon = app.icon;
                const dismissable = group.items.some((item) => item.dismissable);
                const count = badgeLabel(group.total);
                return (
                    <div key={group.app} role="group" aria-label={app.label} className="pt-1">
                        <div className="flex min-w-0 items-center gap-1">
                            <DropdownMenuItem asChild className="min-w-0 flex-1 gap-2 py-1.5">
                                <Link href={app.href}>
                                    <span className="grid size-5 shrink-0 place-items-center rounded bg-primary/15 text-primary">
                                        <Icon className="!size-3.5" aria-hidden="true" />
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-xs font-semibold">
                                        {app.label}
                                    </span>
                                    {count ? (
                                        <span className="shrink-0 text-[0.6875rem] tabular-nums text-muted-foreground">
                                            {count}
                                        </span>
                                    ) : null}
                                </Link>
                            </DropdownMenuItem>
                            {dismissable ? (
                                <DropdownMenuItem
                                    className={ICON_BUTTON}
                                    aria-label={t(
                                        group.app === "admin"
                                            ? "waitingList.markAllSeen"
                                            : "waitingList.markAllRead",
                                        { app: app.label }
                                    )}
                                    title={t(
                                        group.app === "admin"
                                            ? "waitingList.markAllSeen"
                                            : "waitingList.markAllRead",
                                        { app: app.label }
                                    )}
                                    onSelect={(event) => {
                                        event.preventDefault();
                                        void mark(group.app, null);
                                    }}
                                >
                                    <CheckCheck aria-hidden="true" />
                                </DropdownMenuItem>
                            ) : null}
                        </div>
                        <ul className="min-w-0">
                            {group.items.map((item) => (
                                <WaitingRow
                                    key={item.id}
                                    app={group.app}
                                    item={item}
                                    onMark={() => void mark(group.app, item.id)}
                                />
                            ))}
                        </ul>
                    </div>
                );
            })}
        </section>
    );
}

/** One entry: what it is, and its own mark. */
function WaitingRow({
    app,
    item,
    onMark
}: {
    app: LauncherWaitingApp;
    item: LauncherWaitingItem;
    onMark: () => void;
}) {
    const t = useTranslations("nav");
    const { title, detail } = describe(app, item, t);
    const count = item.count > 1 ? badgeLabel(item.count) : null;
    const markLabel = t(app === "admin" ? "waitingList.markSeen" : "waitingList.markRead", {
        item: title
    });
    return (
        <li className="flex min-w-0 items-center gap-1 pl-7">
            <DropdownMenuItem asChild className="min-w-0 flex-1 gap-2 py-1">
                <Link href={item.href} title={detail ? `${title} - ${detail}` : title}>
                    <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs">{title}</span>
                        {detail ? (
                            <span className="block truncate text-[0.6875rem] text-muted-foreground">
                                {detail}
                            </span>
                        ) : null}
                    </span>
                    {count ? (
                        <span className="shrink-0 rounded-full bg-primary px-1.5 text-[0.625rem] font-medium leading-4 text-primary-foreground">
                            {count}
                        </span>
                    ) : null}
                </Link>
            </DropdownMenuItem>
            {item.dismissable ? (
                <DropdownMenuItem
                    className={ICON_BUTTON}
                    aria-label={markLabel}
                    title={markLabel}
                    onSelect={(event) => {
                        event.preventDefault();
                        onMark();
                    }}
                >
                    <Check aria-hidden="true" />
                </DropdownMenuItem>
            ) : (
                // The same width as a mark, so the rows line up.
                <span className="size-7 shrink-0" aria-hidden="true" />
            )}
        </li>
    );
}

/** The words an entry is drawn with. Management's come from the catalogue by
 *  what the entry is; the others are the conversation's name and the sender. */
function describe(
    app: LauncherWaitingApp,
    item: LauncherWaitingItem,
    t: NamespaceTranslator<"nav">
): { title: string; detail: string } {
    if (app === "admin") {
        const key = `waitingList.admin.${item.id}` as NamespaceKey<"nav">;
        return { title: t.has(key) ? t(key, { count: item.count }) : item.id, detail: "" };
    }
    if (app === "mail")
        return {
            title: item.title || t("waitingList.unknownSender"),
            detail: item.detail || t("waitingList.noSubject")
        };
    return { title: item.title, detail: item.detail };
}
