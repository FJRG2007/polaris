"use client";

/**
 * The announcements showing for this reader, stacked at the top of the screen.
 *
 * Arrives with the page (see `AnnouncementBanners`), so there is nothing to
 * wait for and nothing shifts after the first paint. After that it follows
 * along: the live channel says when one is published, edited, withdrawn or
 * closed in another tab, and a timer reads again at the next phase boundary
 * (maintenance ahead, under way, over), so nobody has to reload. Closing one hides it at
 * once and is undone if the server refuses; critical ones and maintenance under
 * way have no close button. A countdown ticks while maintenance is ahead.
 */

import Link from "next/link";
import { cn } from "@polaris/ui";
import type { Locale } from "@polaris/core";
import { rereadDelay } from "@/lib/announcements/phase";
import { useNoticeFrames } from "@/components/use-notice-frames";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { BannerState, BannerView } from "@/lib/announcements/service";
import { AnnouncementMarkdown } from "./announcement-markdown";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { formatDuration } from "@/lib/announcements/placeholders";
import {
    announcementBannersAction,
    dismissAnnouncementAction
} from "@/app/(app)/announcement-actions";
import { AlertTriangle, CheckCircle2, Info, Megaphone, Wrench, X } from "lucide-react";

const TONE: Record<string, string> = {
    info: "border-sky-500/30 bg-sky-500/10 text-sky-950 dark:text-sky-100",
    success: "border-success-edge bg-success-soft text-success-ink",
    warning: "border-warning-edge bg-warning-soft text-warning-ink",
    critical: "border-danger-edge bg-danger-soft text-danger-ink"
};

function Icon({ banner }: { banner: BannerView }) {
    const className = "mt-0.5 size-4 shrink-0";
    if (banner.phase === "upcoming" || banner.phase === "inProgress")
        return <Wrench className={className} aria-hidden />;
    if (banner.severity === "critical" || banner.severity === "warning") {
        return <AlertTriangle className={className} aria-hidden />;
    }
    if (banner.severity === "success" || banner.phase === "finished") {
        return <CheckCircle2 className={className} aria-hidden />;
    }
    return banner.severity === "info" ? (
        <Info className={className} aria-hidden />
    ) : (
        <Megaphone className={className} aria-hidden />
    );
}

function useNow(enabled: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!enabled) return;
        const timer = window.setInterval(() => setNow(Date.now()), 30_000);
        return () => window.clearInterval(timer);
    }, [enabled]);
    return now;
}

/**
 * The banners as the server last said, read again on a live frame and at the
 * next phase boundary. An answer that arrives after a newer one is dropped.
 */
export function useLiveBanners(initial: BannerState, read: () => Promise<BannerState>): BannerState {
    const [state, setState] = useState(initial);
    const asked = useRef(0);
    const reread = useCallback(() => {
        const ticket = ++asked.current;
        read()
            .then((next) => {
                if (ticket === asked.current) setState(next);
            })
            // A failed read keeps what is on screen; the next frame or boundary tries again.
            .catch(() => undefined);
    }, [read]);
    useNoticeFrames("announcements", reread);
    useEffect(() => {
        const timer = window.setTimeout(reread, rereadDelay(state.nextChangeInMs));
        return () => window.clearTimeout(timer);
    }, [state, reread]);
    return state;
}

export function AnnouncementBannerList({
    initial,
    locale
}: {
    initial: BannerState;
    locale: Locale;
}) {
    const t = useTranslations("announcements");
    const { banners } = useLiveBanners(initial, announcementBannersAction);
    const [hidden, setHidden] = useState<readonly string[]>([]);
    const [, startTransition] = useTransition();
    const now = useNow(banners.some((banner) => banner.countdownTo !== null));
    const shown = banners.filter((banner) => !hidden.includes(banner.id));
    if (shown.length === 0) return null;

    const dismiss = (id: string) => {
        setHidden((current) => [...current, id]);
        startTransition(async () => {
            const result = await dismissAnnouncementAction(id).catch(() => ({ ok: false }));
            if (!result.ok) setHidden((current) => current.filter((one) => one !== id));
        });
    };

    return (
        <section aria-label={t("banner.region")} className="flex flex-col gap-2">
            {shown.map((banner) => {
                const left = banner.countdownTo ? Date.parse(banner.countdownTo) - now : null;
                const phaseLabel =
                    banner.phase === "upcoming" ||
                    banner.phase === "inProgress" ||
                    banner.phase === "finished"
                        ? t(`banner.phase.${banner.phase}`)
                        : null;
                return (
                    <div
                        key={banner.id}
                        role={banner.severity === "critical" ? "alert" : "status"}
                        className={cn(
                            "flex items-start gap-3 rounded-lg border px-3 py-2 text-sm",
                            TONE[banner.severity] ?? TONE.info
                        )}
                    >
                        <Icon banner={banner} />
                        <div className="min-w-0 grow">
                            {phaseLabel || left !== null ? (
                                <p className="text-xs font-medium opacity-80">
                                    {[
                                        phaseLabel,
                                        left === null
                                            ? null
                                            : left > 60_000
                                              ? t("banner.startsIn", {
                                                    time: formatDuration(left, locale)
                                                })
                                              : t("banner.startsNow")
                                    ]
                                        .filter(Boolean)
                                        .join(" - ")}
                                </p>
                            ) : null}
                            <p className="break-words font-medium">{banner.title}</p>
                            <AnnouncementMarkdown
                                source={banner.body}
                                className="mt-0.5 text-xs opacity-90"
                            />
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                            {banner.linkUrl ? (
                                banner.linkUrl.startsWith("/") ? (
                                    <Link
                                        href={banner.linkUrl}
                                        className="max-w-40 truncate rounded-md border border-current/20 px-2 py-1 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/10"
                                    >
                                        {banner.linkLabel ?? banner.linkUrl}
                                    </Link>
                                ) : (
                                    <a
                                        href={banner.linkUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="max-w-40 truncate rounded-md border border-current/20 px-2 py-1 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/10"
                                    >
                                        {banner.linkLabel ?? banner.linkUrl}
                                    </a>
                                )
                            ) : null}
                            {banner.dismissible ? (
                                <button
                                    type="button"
                                    onClick={() => dismiss(banner.id)}
                                    aria-label={t("banner.dismiss")}
                                    title={t("banner.dismiss")}
                                    className="-my-1.5 -mr-2 inline-flex size-11 items-center justify-center rounded-md opacity-70 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
                                >
                                    <X className="size-4 shrink-0" aria-hidden />
                                </button>
                            ) : null}
                        </div>
                    </div>
                );
            })}
        </section>
    );
}
