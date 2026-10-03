"use client";

/**
 * Arranging the favorites as a list: the way to do it with a finger or a
 * keyboard, where dragging tiles in the app menu is the way with a mouse.
 *
 * Nextcloud's navigation bar settings are the model - the apps in order, each
 * with a button to move it up or down - with the rest of the apps below, one
 * button each to make them a favorite. Every change is saved as it is made
 * (see `favorite-apps`), so there is nothing to confirm and nothing to lose by
 * closing it.
 */

import type { ReactNode } from "react";
import type { PolarisApp } from "@polaris/ui";
import { moveFavorite } from "@/lib/app-launcher";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useFavoriteApps } from "@/components/favorite-apps-context";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

const ICON_BUTTON =
    "grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground active:bg-muted aria-disabled:pointer-events-none aria-disabled:opacity-40";

export function ArrangeFavoritesDialog({
    open,
    onOpenChange,
    apps
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The apps this account can open, as the menu draws them. */
    apps: readonly PolarisApp[];
}) {
    const t = useTranslations("nav");
    const { favorites, toggle, arrange } = useFavoriteApps();
    const byId = new Map(apps.map((app) => [app.id, app]));
    const chosen = favorites.flatMap((id) => byId.get(id) ?? []);
    const others = apps.filter((app) => !favorites.includes(app.id) && !app.locked);
    const order = chosen.map((app) => app.id);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("switcher.arrange")}</DialogTitle>
                    <DialogDescription>{t("switcher.arrangeHint")}</DialogDescription>
                </DialogHeader>
                <section className="mt-4">
                    <h3 className="px-1 pb-1 text-[0.6875rem] font-medium uppercase tracking-wider text-foreground-subtle">
                        {t("switcher.favorites")}
                    </h3>
                    {chosen.length === 0 ? (
                        <p className="px-1 py-3 text-xs text-muted-foreground">
                            {t("switcher.noFavorites")}
                        </p>
                    ) : (
                        <ol className="flex flex-col">
                            {chosen.map((app, at) => (
                                <Row key={app.id} app={app}>
                                    <IconButton
                                        label={t("switcher.moveEarlier", { app: app.label })}
                                        blocked={at === 0}
                                        onClick={() => arrange(moveFavorite(order, app.id, -1))}
                                    >
                                        <ArrowUp className="size-4" aria-hidden="true" />
                                    </IconButton>
                                    <IconButton
                                        label={t("switcher.moveLater", { app: app.label })}
                                        blocked={at === chosen.length - 1}
                                        onClick={() => arrange(moveFavorite(order, app.id, 1))}
                                    >
                                        <ArrowDown className="size-4" aria-hidden="true" />
                                    </IconButton>
                                    <IconButton
                                        label={t("switcher.unpin", { app: app.label })}
                                        onClick={() => toggle(app.id)}
                                    >
                                        <X className="size-4" aria-hidden="true" />
                                    </IconButton>
                                </Row>
                            ))}
                        </ol>
                    )}
                </section>
                {others.length > 0 ? (
                    <section className="mt-4">
                        <h3 className="px-1 pb-1 text-[0.6875rem] font-medium uppercase tracking-wider text-foreground-subtle">
                            {t("switcher.otherApps")}
                        </h3>
                        <ul className="flex flex-col">
                            {others.map((app) => (
                                <Row key={app.id} app={app}>
                                    <IconButton
                                        label={t("switcher.pin", { app: app.label })}
                                        onClick={() => toggle(app.id)}
                                    >
                                        <Plus className="size-4" aria-hidden="true" />
                                    </IconButton>
                                </Row>
                            ))}
                        </ul>
                    </section>
                ) : null}
            </DialogContent>
        </Dialog>
    );
}

function Row({ app, children }: { app: PolarisApp; children: ReactNode }) {
    const Icon = app.icon;
    return (
        <li className="flex min-w-0 items-center gap-2.5 rounded-md px-1 py-0.5">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
                <Icon className="size-4" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1 truncate text-[0.8125rem]" title={app.label}>
                {app.label}
            </span>
            <span className="flex shrink-0 items-center">{children}</span>
        </li>
    );
}

function IconButton({
    label,
    blocked = false,
    onClick,
    children
}: {
    label: string;
    blocked?: boolean;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            aria-disabled={blocked || undefined}
            onClick={() => {
                if (!blocked) onClick();
            }}
            className={cn(ICON_BUTTON)}
        >
            {children}
        </button>
    );
}
