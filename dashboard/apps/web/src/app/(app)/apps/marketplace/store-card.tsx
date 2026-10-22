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
import type { ReactNode } from "react";
import { AppMark } from "@/components/app-mark";
import { initialsInk, tintFor } from "@polaris/core";
import type { AppManifest } from "@/lib/apps/catalog";
import styles from "./[appId]/screenshots.module.css";
import { Loader2, Lock, MoreHorizontal } from "lucide-react";
import type { AppScreenshot } from "@/lib/apps/app-screenshots";
import type { PrimaryAction } from "@/lib/apps/marketplace-store";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    Badge,
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    cn
} from "@polaris/ui";

/**
 * The preview's height: 16:10 of its width, rounded down to a whole pixel.
 *
 * A plain `aspect-[16/10]` gives a fractional height for almost every column
 * width (a 415px card is 259.375px tall), and every card body and every row
 * below it then starts between two pixels. A browser that scrolls in
 * fractions of a pixel snaps each line of text to the pixel grid on its own,
 * so while the page moves the text steps up and down against the borders
 * around it. `round()` against the container's width keeps the height whole;
 * a browser without `round()` drops the declaration and keeps the ratio.
 */
export const PREVIEW_HEIGHT = "aspect-[16/10] h-[round(down,calc(100cqw*10/16),1px)]";

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
    const box = cn("overflow-hidden [container-type:inline-size]", className);
    const frame = cn("relative w-full overflow-hidden bg-surface", PREVIEW_HEIGHT);
    if (shot) {
        return (
            <div className={box}>
                <div className={frame}>
                    {(["dark", "light"] as const).map((theme) => (
                        <picture key={theme} className={styles[theme]}>
                            <source media="(max-width: 640px)" srcSet={shot[theme].mobile} />
                            {/* eslint-disable-next-line @next/next/no-img-element -- static webp, no optimizer needed */}
                            <img
                                src={shot[theme].desktop}
                                alt={t("card.preview", { name: app.name })}
                                loading={eager ? "eager" : "lazy"}
                                className="size-full object-cover object-top"
                            />
                        </picture>
                    ))}
                </div>
            </div>
        );
    }
    const tint = tintFor(app.id);
    return (
        <div className={box}>
            <div
                className={cn(
                    frame,
                    "flex flex-col items-center justify-center gap-2 p-4 text-center"
                )}
                style={{ backgroundColor: tint, color: initialsInk(tint) }}
                data-preview="placeholder"
                role="img"
                aria-label={t("card.preview", { name: app.name })}
            >
                <span className="rounded-xl bg-background/90 p-2 shadow-sm">
                    <AppMark app={app} size={44} />
                </span>
                <span className="max-w-full truncate text-sm font-semibold" title={app.name}>
                    {app.name}
                </span>
                <span className="line-clamp-2 max-w-[28ch] text-xs opacity-80">{app.summary}</span>
            </div>
        </div>
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

/** Running, stopped, failed or installing, in the colour the rest of Polaris uses. */
export function StatusBadge({ status, label }: { status: string; label: string }) {
    return (
        <Badge
            className={cn(
                status === "failed" && "border-danger-edge text-danger",
                status === "running" && "border-success-edge text-success"
            )}
        >
            {label}
        </Badge>
    );
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

/** A card's frame: the preview on top, the body below, the whole height of its row. */
export function StoreCardFrame({
    preview,
    children,
    muted
}: {
    preview: ReactNode;
    children: ReactNode;
    muted?: boolean;
}) {
    return (
        <article
            className={cn(
                "flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card",
                muted && "opacity-75"
            )}
        >
            {preview}
            <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">{children}</div>
        </article>
    );
}
