"use client";

/**
 * Polar drawn as the account it behaves like, the way a bot is drawn on any
 * platform that has them: its own face, its name with a badge that says it is
 * not a person, and a card behind both that says what it is and where to talk
 * to it. Used wherever Polar appears beside people - a message it wrote, an
 * `@polar` in a message, a task it was handed - so it is one thing everywhere.
 *
 * Polar has no account behind it (an answer is stored with no author), so none
 * of the person components fit: they read a profile by id, and there is none.
 */

import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";
import { restPose } from "./motion/avatar-engine";
import { canvasRatio } from "./motion/motion-runtime";
import { drawAvatar, OVERSCAN, RISE } from "./motion/avatar-draw";
import { usePolarAllowed } from "./polar-allowed";
import { useDecorationSeason } from "@/components/seasonal/seasonal-frame";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Popover, PopoverContent, PopoverTrigger, cn } from "@polaris/ui";

/** What it is called. A name, like a person's, so it is not translated. */
export const POLAR_NAME = "Polar";

/** Polar's face at the size of a person's avatar beside it: the bear of its
 *  animated avatar, painted once. Never animated - it sits in lists, beside
 *  faces that do not move either - and it reads no words, so a public page
 *  that shows a message naming Polar does not need Polar's translations. */
export function PolarFace({ size = 28, className }: { size?: number; className?: string }) {
    const ref = useRef<HTMLCanvasElement | null>(null);
    const box = Math.round(size * 0.8);
    const season = useDecorationSeason();
    useEffect(() => {
        const canvas = ref.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        const ratio = canvasRatio();
        canvas.width = canvas.height = Math.round(box * OVERSCAN * ratio);
        drawAvatar(ctx, box, ratio, restPose("idle"), 0, season);
    }, [box, season]);
    const side = (OVERSCAN - 1) / 2;
    return (
        <span
            role="img"
            aria-label={POLAR_NAME}
            className={cn(
                "relative inline-flex shrink-0 overflow-hidden rounded-full bg-primary/10 align-middle",
                className
            )}
            style={{ width: size, height: size }}
        >
            <canvas
                ref={ref}
                aria-hidden="true"
                className="absolute block"
                style={{
                    width: box * OVERSCAN,
                    height: box * OVERSCAN,
                    left: (size - box) / 2 - box * side,
                    top: (size - box) / 2 - box * (side + RISE)
                }}
            />
        </span>
    );
}

/** The tag beside its name, as Discord's BOT and Slack's APP are. */
export function PolarBadge({ className }: { className?: string }) {
    const t = useTranslations("components");
    return (
        <span
            title={t("polarBot.badgeHint")}
            className={cn(
                "shrink-0 self-center rounded bg-primary px-1 text-[0.625rem] font-semibold uppercase leading-4 text-primary-foreground",
                className
            )}
        >
            {t("polarBot.badge")}
        </span>
    );
}

/** The card a press on Polar's face, name or mention opens. `children` is the
 *  one element that opens it, a button. */
export function PolarBotCard({ children }: { children: ReactNode }) {
    const t = useTranslations("components");
    const allowed = usePolarAllowed();
    return (
        <Popover>
            <PopoverTrigger asChild>{children}</PopoverTrigger>
            <PopoverContent align="start" className="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-3 p-4">
                <div className="flex min-w-0 items-center gap-3">
                    <PolarFace size={48} />
                    <div className="flex min-w-0 flex-col">
                        <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate font-semibold" title={POLAR_NAME}>{POLAR_NAME}</span>
                            <PolarBadge />
                        </span>
                        <span className="truncate text-xs text-muted-foreground" title={t("polarBot.role")}>
                            {t("polarBot.role")}
                        </span>
                    </div>
                </div>
                <p className="text-sm text-muted-foreground">{t("polarBot.about")}</p>
                {allowed ? (
                    <Button asChild size="sm" className="self-start">
                        <Link href="/polar">{t("polarBot.open")}</Link>
                    </Button>
                ) : (
                    <p className="text-xs text-foreground-subtle">{t("polarBot.unavailable")}</p>
                )}
            </PopoverContent>
        </Popover>
    );
}

/** `@polar` in a message that was sent: a mention like a person's, with its
 *  face, that opens the card. */
export function PolarMention({ text }: { text: string }) {
    const t = useTranslations("components");
    return (
        <PolarBotCard>
            <button
                type="button"
                title={t("polarBot.mentionHint")}
                className="inline-flex items-center gap-1 rounded bg-primary/15 px-1 py-0.5 align-baseline font-medium text-primary hover:bg-primary/25"
            >
                <PolarFace size={14} className="bg-transparent" />
                {text}
            </button>
        </PolarBotCard>
    );
}
