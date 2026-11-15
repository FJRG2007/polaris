"use client";

/**
 * A panel's cards fitted to the box they are drawn in (`fitPanel`): the wall's
 * screen, or the preview frame in Arrange. The box is measured as it changes -
 * a tablet turned, a window resized - and the grid is laid out again. Cards
 * never shrink below the panel's card size; what does not fit is on the next
 * page, reached by a swipe or the page buttons under the grid.
 *
 * The text scale is applied with CSS `zoom` on the grid, and the fit is asked
 * for the box divided by it, so a larger text scale is fewer, bigger cards
 * rather than text spilling out of them.
 */

import { cn } from "@polaris/ui";
import { DENSITY } from "./panel-state";
import { usePlacesT } from "../use-places-t";
import { fitPanel, type FitCard } from "../../lib/panel-fit";
import type { PanelCard, PanelStyle } from "../../lib/panel-layout";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** How far a finger travels sideways before it is a swipe, in pixels. */
const SWIPE_PX = 60;

export function PanelFitGrid({
    cards,
    style,
    kindOf,
    render,
    className
}: {
    /** In the order the wall reads them. */
    cards: readonly PanelCard[];
    style: Pick<PanelStyle, "density" | "cardSize" | "textScale">;
    /** A device card's device kind, for the span it asks for. */
    kindOf: (card: PanelCard) => string | undefined;
    render: (card: PanelCard) => ReactNode;
    className?: string;
}) {
    const t = usePlacesT();
    const box = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState<{ width: number; height: number } | null>(null);
    const [page, setPage] = useState(0);
    const swipe = useRef<number | null>(null);
    useEffect(() => {
        const node = box.current;
        if (!node || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(([entry]) => {
            if (!entry) return;
            const { width, height } = entry.contentRect;
            setSize((now) =>
                now && Math.abs(now.width - width) < 1 && Math.abs(now.height - height) < 1
                    ? now
                    : { width, height }
            );
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    const scale = style.textScale / 100;
    const gap = DENSITY[style.density].gap * 16;
    // Room kept under the grid for the page buttons, should there be pages.
    const pager = 72;
    const fit = useMemo(() => {
        if (!size) return null;
        const fitCards: FitCard[] = cards.map((card) => ({
            id: card.id,
            type: card.type,
            w: card.w,
            h: card.h,
            kind: kindOf(card)
        }));
        const input = {
            width: size.width / scale,
            height: size.height / scale,
            cards: fitCards,
            cardSize: style.cardSize,
            gap
        };
        const once = fitPanel(input);
        return once.pages > 1
            ? fitPanel({ ...input, height: (size.height - pager) / scale })
            : once;
    }, [size, cards, kindOf, scale, style.cardSize, gap]);
    const pages = fit?.pages ?? 1;
    const shown = Math.min(page, pages - 1);
    const byId = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);
    const go = (next: number) => setPage(Math.max(0, Math.min(pages - 1, next)));

    return (
        <div ref={box} className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", className)}>
            {fit ? (
                <div
                    className="grid touch-pan-y select-none"
                    style={{
                        zoom: scale,
                        gap: `${gap}px`,
                        gridTemplateColumns: `repeat(${fit.columns}, minmax(0, 1fr))`,
                        gridAutoRows: `${fit.cellH}px`,
                        "--panel-pad": `${DENSITY[style.density].pad}rem`
                    } as React.CSSProperties}
                    onPointerDown={(event) => {
                        swipe.current = event.clientX;
                    }}
                    onPointerUp={(event) => {
                        const start = swipe.current;
                        swipe.current = null;
                        if (start === null) return;
                        const dx = event.clientX - start;
                        if (Math.abs(dx) >= SWIPE_PX) go(shown + (dx < 0 ? 1 : -1));
                    }}
                    onPointerCancel={() => {
                        swipe.current = null;
                    }}
                >
                    {fit.placements
                        .filter((placement) => placement.page === shown)
                        .map((placement) => {
                            const card = byId.get(placement.id);
                            if (!card) return null;
                            return (
                                <div
                                    key={placement.id}
                                    className="min-h-0 min-w-0"
                                    style={{
                                        gridColumn: `${placement.x + 1} / span ${placement.w}`,
                                        gridRow: `${placement.y + 1} / span ${placement.h}`
                                    }}
                                >
                                    {render(card)}
                                </div>
                            );
                        })}
                </div>
            ) : null}
            {pages > 1 ? (
                <nav
                    aria-label={t("panelWall.pages")}
                    className="mt-auto flex shrink-0 items-center justify-center gap-3 pt-3"
                >
                    {Array.from({ length: pages }, (_, index) => (
                        <button
                            key={index}
                            type="button"
                            aria-current={index === shown ? "page" : undefined}
                            aria-label={t("panelWall.page", { page: index + 1, count: pages })}
                            title={t("panelWall.page", { page: index + 1, count: pages })}
                            onClick={() => go(index)}
                            className="flex size-14 items-center justify-center rounded-full"
                        >
                            <span
                                className={cn(
                                    "size-4 rounded-full transition-colors",
                                    index === shown ? "bg-primary" : "bg-muted-foreground/40"
                                )}
                            />
                        </button>
                    ))}
                </nav>
            ) : null}
        </div>
    );
}
