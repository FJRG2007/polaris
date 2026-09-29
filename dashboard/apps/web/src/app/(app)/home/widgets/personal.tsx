"use client";

/**
 * The cards the browser answers on its own: what somebody pinned, where they
 * have been, what they have been told, and the apps they can open.
 *
 * None of them costs a request. The pinned links come down with the page as part
 * of the account's preferences, the history is this browser's own, the feed is
 * the one the bell already holds, and the launcher is the list the switcher was
 * built from - so four of the nine cards are on screen complete before the first
 * fetch has even been sent.
 */

import Link from "next/link";
import { Button, cn } from "@polaris/ui";
import { POLARIS_APPS } from "@/lib/apps";
import { useEffect, useState } from "react";
import { shortcutIcon } from "../shortcut-icons";
import { RelativeTime } from "@/components/relative-time";
import { useNavLabel } from "@/components/i18n/use-nav-label";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { OverviewShortcut, RecentPlace } from "@polaris/core";
import { WidgetEmpty, WidgetList, WidgetRow } from "../widget-card";
import { forgetPlace, readRecentPlaces } from "@/lib/overview/recent-places";
import { Bell, Clock, LayoutGrid, Link2, Plus, X, type LucideIcon } from "lucide-react";
import { useNotificationFeed } from "@/components/notifications/notifications-provider";

/** How many rows a list card shows. Past this it is a screen, not a card. */
const ROWS = 5;

export function ShortcutsWidget({
    shortcuts,
    onAdd,
    onRemove
}: {
    shortcuts: readonly OverviewShortcut[];
    onAdd: () => void;
    onRemove: (href: string) => void;
}) {
    const t = useTranslations("home");
    if (shortcuts.length === 0) {
        return (
            <WidgetEmpty
                action={
                    <Button size="sm" variant="outline" onClick={onAdd}>
                        <Plus className="size-4" aria-hidden="true" />
                        {t("shortcuts.pin")}
                    </Button>
                }
            >
                {t("shortcuts.empty")}
            </WidgetEmpty>
        );
    }

    return (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {shortcuts.map((shortcut) => {
                const Icon: LucideIcon = shortcutIcon(shortcut.href) ?? Link2;
                return (
                    <div key={shortcut.href} className="group relative">
                        <Link
                            href={shortcut.href}
                            className="flex h-full flex-col gap-1.5 rounded-lg border border-border bg-surface/50 p-3 transition-colors hover:border-primary hover:bg-primary/5"
                        >
                            <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                            <span className="truncate text-sm font-medium" title={shortcut.label}>{shortcut.label}</span>
                            {shortcut.context ? (
                                <span className="truncate text-xs text-muted-foreground" title={shortcut.context}>{shortcut.context}</span>
                            ) : null}
                        </Link>
                        <button
                            type="button"
                            onClick={() => onRemove(shortcut.href)}
                            title={t("shortcuts.unpin", { name: shortcut.label })}
                            aria-label={t("shortcuts.unpin", { name: shortcut.label })}
                            className="absolute right-1 top-1 grid size-6 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                        >
                            <X className="size-3.5" aria-hidden="true" />
                        </button>
                    </div>
                );
            })}
            <button
                type="button"
                onClick={onAdd}
                className="flex min-h-[4.5rem] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
            >
                <Plus className="size-4" aria-hidden="true" />
                <span className="text-xs">{t("shortcuts.pin")}</span>
            </button>
        </div>
    );
}

/**
 * Where this browser has been. Read after mount rather than during render:
 * localStorage does not exist on the server, and a card that guessed at it would
 * hydrate into a different list than it drew.
 */
export function RecentWidget() {
    const t = useTranslations("home");
    const [places, setPlaces] = useState<RecentPlace[] | null>(null);

    useEffect(() => {
        setPlaces(readRecentPlaces());
        // Another tab visiting a page should show up here without a reload.
        function onStorage() {
            setPlaces(readRecentPlaces());
        }
        window.addEventListener("storage", onStorage);
        return () => window.removeEventListener("storage", onStorage);
    }, []);

    if (places === null) return <div className="h-24" aria-hidden="true" />;
    if (places.length === 0) return <WidgetEmpty>{t("recent.empty")}</WidgetEmpty>;

    return (
        <WidgetList>
            {places.slice(0, ROWS).map((place) => (
                <WidgetRow
                    key={place.href}
                    href={place.href}
                    icon={<Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                    label={place.label}
                    detail={place.context}
                    action={
                        <button
                            type="button"
                            onClick={() => setPlaces(forgetPlace(place.href))}
                            title={t("recent.forget", { name: place.label })}
                            aria-label={t("recent.forget", { name: place.label })}
                            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                        >
                            <X className="size-3.5" aria-hidden="true" />
                        </button>
                    }
                />
            ))}
        </WidgetList>
    );
}

/** The bell's feed, newest first. The same store, so reading one here clears the
 *  badge above. */
export function NotificationsWidget() {
    const feed = useNotificationFeed();
    const t = useTranslations("home");
    if (feed.items.length === 0) return <WidgetEmpty>{t("notifications.empty")}</WidgetEmpty>;

    return (
        <WidgetList>
            {feed.items.slice(0, ROWS).map((item) => (
                <WidgetRow
                    key={item.id}
                    href={item.href ?? "/account/notifications"}
                    icon={
                        <span
                            className={cn(
                                "grid size-7 shrink-0 place-items-center rounded-md",
                                item.read ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"
                            )}
                        >
                            <Bell className="size-3.5" aria-hidden="true" />
                        </span>
                    }
                    label={item.title}
                    detail={item.body}
                    trailing={
                        <span className="shrink-0 text-xs text-muted-foreground">
                            <RelativeTime iso={item.createdAt} />
                        </span>
                    }
                />
            ))}
        </WidgetList>
    );
}

/** Every app this account can open. The icons come from the registry the
 *  switcher uses, so an app added there appears here too. */
export function AppsWidget({
    apps
}: {
    apps: readonly { id: string; label: string; description: string; href: string }[];
}) {
    const t = useTranslations("home");
    const tnav = useTranslations("nav");
    const navLabel = useNavLabel();
    if (apps.length === 0) return <WidgetEmpty>{t("apps.empty")}</WidgetEmpty>;
    // The same sentence the switcher shows for the app, in the reader's language.
    const describe = (id: string, english: string) => {
        const key = `apps.${id}.description`;
        return tnav.has(key) ? tnav(key) : english;
    };

    return (
        <div className="grid grid-cols-2 gap-2">
            {apps.map((app) => {
                const Icon = POLARIS_APPS.find((entry) => entry.id === app.id)?.icon ?? LayoutGrid;
                return (
                    <Link
                        key={app.id}
                        href={app.href}
                        title={describe(app.id, app.description)}
                        className="flex items-center gap-2 rounded-lg border border-border bg-surface/50 px-3 py-2 transition-colors hover:border-primary hover:bg-primary/5"
                    >
                        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="truncate text-sm font-medium">{navLabel(app.label)}</span>
                    </Link>
                );
            })}
        </div>
    );
}
