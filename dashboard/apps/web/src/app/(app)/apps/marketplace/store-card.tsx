"use client";

/**
 * The pieces a store listing is built from: the preview at the top of a card,
 * the one action it leads with, and the overflow menu that holds the rest.
 *
 * The preview is the app's first real capture. An app nobody has captured yet
 * gets a placeholder drawn from what it already is - its mark, name and summary
 * on its own colour - and never a mocked-up screen.
 */

import Link from "next/link";
import { AppMark } from "@/components/app-mark";
import { initialsInk, tintFor } from "@polaris/core";
import type { AppManifest } from "@/lib/apps/catalog";
import { Loader2, Lock, MoreHorizontal } from "lucide-react";
import type { AppScreenshot } from "@/lib/apps/app-screenshots";
import { PREVIEW_HEIGHT, StatusBadge, StoreCardFrame, StorePreview } from "@polaris/ui/store-card";

export { PREVIEW_HEIGHT, StatusBadge, StoreCardFrame };
import type { PrimaryAction } from "@/lib/apps/marketplace-store";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    Badge,
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@polaris/ui";

/**
 * A 16:10 preview: the capture in the reader's theme (picked by CSS, so the
 * first paint is already right), or the designed placeholder.
 */
export function AppPreview({
    app,
    shot,
    className,
    eager = false
}: {
    app: AppManifest;
    shot: AppScreenshot | null;
    className?: string;
    eager?: boolean;
}) {
    const t = useTranslations("marketplace");
    const tint = tintFor(app.id);
    return (
        <StorePreview
            name={app.name}
            summary={app.summary}
            mark={<AppMark app={app} size={44} />}
            tint={tint}
            ink={initialsInk(tint)}
            shot={shot}
            alt={t("card.preview", { name: app.name })}
            className={className}
            eager={eager}
        />
    );
}

/** The leading action, as a button or a link; a state with nothing to press reads as a badge. */
export function PrimaryActionButton({
    action,
    onInstall,
    disabled,
    size = "sm"
}: {
    action: PrimaryAction;
    onInstall: () => void;
    /** Another install is running: one at a time keeps the deploy queue and this page honest. */
    disabled: boolean;
    size?: "sm" | "md";
}) {
    const t = useTranslations("marketplace");
    switch (action.kind) {
        case "open":
            return (
                <Button asChild size={size}>
                    <Link href={action.href}>{t("card.open")}</Link>
                </Button>
            );
        case "installing":
            return (
                <Button size={size} disabled aria-busy>
                    <Loader2 className="size-4 animate-spin" />
                    {t("card.installing")}
                </Button>
            );
        case "install":
            return (
                <Button size={size} onClick={onInstall} disabled={disabled}>
                    {t("card.install")}
                </Button>
            );
        case "deploy":
            return (
                <Button size={size} onClick={onInstall} disabled={disabled}>
                    {t("card.deploy")}
                </Button>
            );
        case "locked":
            return (
                <Button
                    size={size}
                    aria-disabled
                    title={t("card.lockedHint")}
                    className="cursor-not-allowed opacity-50"
                >
                    <Lock className="size-3.5" />
                    {t("card.locked")}
                </Button>
            );
        case "comingSoon":
            return <Badge className="text-muted-foreground">{t("card.comingSoon")}</Badge>;
        case "unavailable":
            return <Badge className="text-muted-foreground">{t("card.unavailable")}</Badge>;
    }
}

export interface OverflowEntry {
    readonly key: string;
    readonly label: string;
    readonly onSelect: () => void;
    readonly danger?: boolean;
    readonly disabled?: boolean;
}

/**
 * Everything a card offers besides its leading action. Rendered only when it
 * has something in it, so a reader who may do nothing more sees no empty menu.
 */
export function OverflowMenu({ label, entries }: { label: string; entries: OverflowEntry[] }) {
    if (entries.length === 0) return null;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" aria-label={label} title={label}>
                    <MoreHorizontal className="size-4" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                {entries.map((entry) => (
                    <DropdownMenuItem
                        key={entry.key}
                        onSelect={entry.onSelect}
                        disabled={entry.disabled}
                        variant={entry.danger ? "danger" : "default"}
                    >
                        {entry.label}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
