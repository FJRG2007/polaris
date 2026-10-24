"use client";

/**
 * A panel's cards on its grid. Twelve columns on a screen wide enough, one on
 * a phone (in the order the wide grid reads). Arranging, a card moves by its
 * handle and resizes by its corner, a cell at a time, with the pointer or the
 * arrow keys (Shift for size); a move that would cover another card is not
 * made (`moveCard`, `resizeCard`).
 */

import { Button, cn } from "@polaris/ui";
import { usePlacesT } from "../use-places-t";
import { GripVertical, MoveDiagonal2, X } from "lucide-react";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
    PANEL_COLUMNS,
    moveCard,
    resizeCard,
    stackOrder,
    type PanelCard
} from "../../lib/panel-layout";

/** Rows are this tall, in rem: a device tile of two rows has room for a switch
 *  and a slider at a size a finger finds. */
const ROW_REM = 5.5;

interface Drag {
    readonly id: string;
    readonly mode: "move" | "resize";
    readonly startX: number;
    readonly startY: number;
    readonly card: PanelCard;
    readonly cellW: number;
    readonly cellH: number;
}

export function PanelGrid({
    cards,
    editing,
    onChange,
    render,
    labelOf
}: {
    cards: readonly PanelCard[];
    editing: boolean;
    onChange: (cards: PanelCard[]) => void;
    render: (card: PanelCard) => ReactNode;
    labelOf: (card: PanelCard) => string;
}) {
    const t = usePlacesT();
    const grid = useRef<HTMLDivElement>(null);
    const [drag, setDrag] = useState<Drag | null>(null);
    const [preview, setPreview] = useState<PanelCard[] | null>(null);
    const shown = preview ?? [...cards];

    const begin = (event: React.PointerEvent, card: PanelCard, mode: Drag["mode"]) => {
        const box = grid.current?.getBoundingClientRect();
        if (!box) return;
        event.preventDefault();
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        const rowPx = parseFloat(getComputedStyle(document.documentElement).fontSize) * ROW_REM;
        setDrag({
            id: card.id,
            mode,
            startX: event.clientX,
            startY: event.clientY,
            card,
            cellW: box.width / PANEL_COLUMNS,
            cellH: rowPx
        });
    };
    const follow = (event: React.PointerEvent) => {
        if (!drag) return;
        const dx = Math.round((event.clientX - drag.startX) / drag.cellW);
        const dy = Math.round((event.clientY - drag.startY) / drag.cellH);
        setPreview(
            drag.mode === "move"
                ? moveCard(cards, drag.id, drag.card.x + dx, drag.card.y + dy)
                : resizeCard(cards, drag.id, drag.card.w + dx, drag.card.h + dy)
        );
    };
    const end = () => {
        if (preview) onChange(preview);
        setDrag(null);
        setPreview(null);
    };
    const nudge = (event: React.KeyboardEvent, card: PanelCard) => {
        const steps: Record<string, [number, number]> = {
            ArrowLeft: [-1, 0],
            ArrowRight: [1, 0],
            ArrowUp: [0, -1],
            ArrowDown: [0, 1]
        };
        const step = steps[event.key];
        if (!step) return;
        event.preventDefault();
        onChange(
            event.shiftKey
                ? resizeCard(cards, card.id, card.w + step[0], card.h + step[1])
                : moveCard(cards, card.id, card.x + step[0], card.y + step[1])
        );
    };

    return (
        <div className={cn(editing && "overflow-x-auto overscroll-x-contain")}>
            <div
                ref={grid}
                onPointerMove={follow}
                onPointerUp={end}
                onPointerCancel={end}
                className={cn(
                    "grid gap-3",
                    // Arranging is done on the wide grid even on a narrow screen,
                    // scrolled sideways inside its box, so what is arranged is
                    // what the wall shows.
                    editing ? "min-w-[48rem] grid-cols-12" : "grid-cols-1 md:grid-cols-12"
                )}
                style={{ gridAutoRows: `${ROW_REM}rem` } as CSSProperties}
            >
                {(editing ? shown : stackOrder(shown)).map((card) => {
                    const label = labelOf(card);
                    const place = {
                        "--panel-col": `${card.x + 1} / span ${card.w}`,
                        "--panel-row": `${card.y + 1} / span ${card.h}`,
                        "--panel-span": `span ${card.h}`
                    } as CSSProperties;
                    return (
                        <div
                            key={card.id}
                            style={place}
                            className={cn(
                                "relative min-w-0 [grid-row:var(--panel-span)]",
                                editing
                                    ? "[grid-column:var(--panel-col)] [grid-row:var(--panel-row)]"
                                    : "md:[grid-column:var(--panel-col)] md:[grid-row:var(--panel-row)]",
                                drag?.id === card.id && "z-10 opacity-90"
                            )}
                        >
                            <div
                                className={cn(
                                    "h-full",
                                    editing && "pointer-events-none select-none"
                                )}
                            >
                                {render(card)}
                            </div>
                            {editing ? (
                                <>
                                    <button
                                        type="button"
                                        aria-label={t("panels.moveCard", { name: label })}
                                        title={t("panels.moveCard", { name: label })}
                                        onPointerDown={(event) => begin(event, card, "move")}
                                        onKeyDown={(event) => nudge(event, card)}
                                        className="absolute left-2 top-2 flex size-9 cursor-grab touch-none items-center justify-center rounded-md border border-border bg-background/90 text-muted-foreground active:cursor-grabbing"
                                    >
                                        <GripVertical className="size-4" />
                                    </button>
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        aria-label={t("panels.removeCard")}
                                        title={t("panels.removeCard")}
                                        onClick={() =>
                                            onChange(cards.filter((entry) => entry.id !== card.id))
                                        }
                                        className="absolute right-2 top-2 size-9 bg-background/90 p-0"
                                    >
                                        <X className="size-4" />
                                    </Button>
                                    <button
                                        type="button"
                                        aria-label={t("panels.resizeCard", { name: label })}
                                        title={t("panels.resizeCard", { name: label })}
                                        onPointerDown={(event) => begin(event, card, "resize")}
                                        onKeyDown={(event) =>
                                            nudge(
                                                { ...event, shiftKey: true } as React.KeyboardEvent,
                                                card
                                            )
                                        }
                                        className="absolute bottom-2 right-2 flex size-9 cursor-nwse-resize touch-none items-center justify-center rounded-md border border-border bg-background/90 text-muted-foreground"
                                    >
                                        <MoveDiagonal2 className="size-4" />
                                    </button>
                                </>
                            ) : null}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
