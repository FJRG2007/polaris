"use client";

/**
 * An app's screenshots as a store shows them: a strip that pages one capture at
 * a time with Previous and Next, or with the arrow keys while it has focus, and
 * a press on a capture opens it full size in the shared image viewer.
 *
 * Each capture is in the strip twice, once per theme, and CSS hides the one that
 * does not match the reader's (see `screenshots.module.css`), so the first paint
 * is already right. The viewer is handed the theme in use at the moment it
 * opens.
 */

import { Button } from "@polaris/ui";
import styles from "./screenshots.module.css";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";
import type { AppScreenshot } from "@/lib/apps/app-screenshots";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ImageViewer, thumbnailOf, type ViewedImage } from "@/components/image-viewer";

/** Whether the page is drawn light right now, the way `screenshots.module.css` decides it. */
function lightNow(): boolean {
    const root = document.documentElement;
    return (
        root.classList.contains("light") ||
        (root.classList.contains("system") &&
            window.matchMedia("(prefers-color-scheme: light)").matches)
    );
}

export function ScreenshotGallery({ name, shots }: { name: string; shots: AppScreenshot[] }) {
    const t = useTranslations("marketplace");
    const strip = useRef<HTMLDivElement>(null);
    const [current, setCurrent] = useState(0);
    const [viewing, setViewing] = useState<ViewedImage | null>(null);
    const [gallery, setGallery] = useState<ViewedImage[]>([]);
    const alt = (index: number) => t("detail.screenshotAlt", { name, index: index + 1 });

    const go = (index: number) => {
        const next = Math.max(0, Math.min(shots.length - 1, index));
        setCurrent(next);
        const item = strip.current?.children[next] as HTMLElement | undefined;
        item?.scrollIntoView?.({ behavior: "smooth", block: "nearest", inline: "start" });
    };

    const onScroll = () => {
        const box = strip.current;
        if (!box || box.children.length === 0) return;
        if (box.scrollLeft + box.clientWidth >= box.scrollWidth - 1) {
            setCurrent(box.children.length - 1);
            return;
        }
        const left = box.getBoundingClientRect().left;
        let nearest = 0;
        let distance = Number.POSITIVE_INFINITY;
        Array.from(box.children).forEach((child, index) => {
            const gap = Math.abs(child.getBoundingClientRect().left - left);
            if (gap < distance) {
                distance = gap;
                nearest = index;
            }
        });
        setCurrent(nearest);
    };

    const open = (index: number) => {
        const theme = lightNow() ? "light" : "dark";
        const now: ViewedImage[] = shots.map((shot, at) => ({
            url: shot[theme].desktop,
            name: alt(at)
        }));
        setGallery(now);
        setViewing(now[index] ?? null);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "ArrowRight") go(current + 1);
        else if (event.key === "ArrowLeft") go(current - 1);
        else return;
        event.preventDefault();
    };

    return (
        <section className="flex min-w-0 flex-col gap-3" aria-label={t("detail.screenshots")}>
            <div className="flex min-w-0 items-center justify-between gap-2">
                <h2 className="text-sm font-medium">{t("detail.screenshots")}</h2>
                {shots.length > 1 && (
                    <div className="flex items-center gap-1">
                        <span className="text-xs text-muted-foreground" aria-live="polite">
                            {t("detail.position", { index: current + 1, count: shots.length })}
                        </span>
                        <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={t("detail.previous")}
                            title={t("detail.previous")}
                            disabled={current === 0}
                            onClick={() => go(current - 1)}
                        >
                            <ChevronLeft className="size-4" />
                        </Button>
                        <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={t("detail.next")}
                            title={t("detail.next")}
                            disabled={current === shots.length - 1}
                            onClick={() => go(current + 1)}
                        >
                            <ChevronRight className="size-4" />
                        </Button>
                    </div>
                )}
            </div>
            <div
                ref={strip}
                role="group"
                aria-roledescription="carousel"
                aria-label={t("detail.screenshots")}
                tabIndex={0}
                onKeyDown={onKeyDown}
                onScroll={onScroll}
                className="flex snap-x snap-mandatory gap-3 overflow-x-auto rounded-md pb-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
                {shots.map((shot, index) => (
                    <figure
                        key={shot.dark.desktop}
                        aria-current={index === current ? "true" : undefined}
                        className="w-[85%] max-w-2xl shrink-0 snap-start sm:w-[70%]"
                    >
                        <button
                            type="button"
                            aria-label={t("detail.openScreenshot", { name: alt(index) })}
                            onClick={() => open(index)}
                            onFocus={() => setCurrent(index)}
                            className="block w-full cursor-zoom-in rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            {(["dark", "light"] as const).map((theme) => (
                                <picture key={theme} className={styles[theme]}>
                                    <source
                                        media="(max-width: 640px)"
                                        srcSet={shot[theme].mobile}
                                    />
                                    {/* eslint-disable-next-line @next/next/no-img-element -- static webp, no optimizer needed */}
                                    <img
                                        src={shot[theme].desktop}
                                        alt={alt(index)}
                                        loading={index === 0 ? "eager" : "lazy"}
                                        className="border-border w-full rounded-md border"
                                    />
                                </picture>
                            ))}
                        </button>
                    </figure>
                ))}
            </div>
            <ImageViewer
                image={viewing}
                gallery={gallery}
                onNavigate={setViewing}
                onClose={() => setViewing(null)}
                origin={thumbnailOf}
            />
        </section>
    );
}
