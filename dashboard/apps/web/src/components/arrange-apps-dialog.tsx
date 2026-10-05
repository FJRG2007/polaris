"use client";

/**
 * Arranging the app menu as a list: the way to do it with a finger or a screen
 * reader, where dragging tiles in the menu is the way with a mouse.
 *
 * Nextcloud's navigation bar settings are the model - the apps in the order the
 * menu draws them, each with a button to move it up or down. That is all there
 * is to arrange: what comes first is what somebody moved first, the same as
 * dragging in the menu. Every change is saved as it is made (see
 * `favorite-apps`), so there is nothing to confirm and nothing to lose by
 * closing it.
 */

import { useState, type ReactNode } from "react";
import type { PolarisApp } from "@polaris/ui";
import { moveFavorite } from "@/lib/app-launcher";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useFavoriteApps } from "@/components/favorite-apps-context";
import {
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

const ICON_BUTTON =
    "grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground active:bg-muted aria-disabled:pointer-events-none aria-disabled:opacity-40";

export function ArrangeAppsDialog({
    open,
    onOpenChange,
    apps,
    order
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The apps this account can open, as the menu draws them. */
    apps: readonly PolarisApp[];
    /** Their ids in the order the menu draws them. */
    order: readonly string[];
}) {
    const t = useTranslations("nav");
    const { order: arranged, arrangeApps, resetOrder } = useFavoriteApps();
    const synced = open ? arranged : null;
    const [shownFor, setShownFor] = useState(synced);
    const [shown, setShown] = useState(order);
    if (shownFor !== synced) {
        setShownFor(synced);
        setShown(order);
    }
    const byId = new Map(apps.map((app) => [app.id, app]));
    const listed = [...shown, ...order.filter((id) => !shown.includes(id))].flatMap((id) =>
        order.includes(id) ? (byId.get(id) ?? []) : []
    );
    const ids = listed.map((app) => app.id);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("switcher.arrange")}</DialogTitle>
                    <DialogDescription>{t("switcher.arrangeHint")}</DialogDescription>
                </DialogHeader>
                <ol className="mt-4 flex flex-col">
                    {listed.map((app, at) => {
                        return (
                            <Row key={app.id} app={app}>
                                <IconButton
                                    label={t("switcher.moveEarlier", { app: app.label })}
                                    blocked={at === 0}
                                    onClick={() => arrangeApps(moveFavorite(ids, app.id, -1))}
                                >
                                    <ArrowUp className="size-4" aria-hidden="true" />
                                </IconButton>
                                <IconButton
                                    label={t("switcher.moveLater", { app: app.label })}
                                    blocked={at === listed.length - 1}
                                    onClick={() => arrangeApps(moveFavorite(ids, app.id, 1))}
                                >
                                    <ArrowDown className="size-4" aria-hidden="true" />
                                </IconButton>
                            </Row>
                        );
                    })}
                </ol>
                {/* Back to favorites first and the rest by use, for somebody
                    who arranged the menu once and would rather it kept up. */}
                {arranged.length > 0 ? (
                    <div className="mt-3 flex justify-end">
                        <Button variant="ghost" size="sm" onClick={resetOrder}>
                            {t("switcher.resetOrder")}
                        </Button>
                    </div>
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
