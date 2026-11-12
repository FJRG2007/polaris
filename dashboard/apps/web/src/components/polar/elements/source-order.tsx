"use client";

/**
 * The picker's "Order providers" view: every group it lists, dragged into
 * place or moved with the up and down buttons (the keyboard's way, and what
 * a screen reader announces). Each move is saved at once.
 */

import { cn } from "@polaris/ui";
import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { applyOrder, moveBy, moveTo } from "@/lib/polar/picker-order";

export interface OrderEntry {
    readonly key: string;
    readonly name: string;
    readonly icon: ReactNode;
}

export function SourceOrderList({
    entries,
    order,
    onOrder
}: {
    entries: readonly OrderEntry[];
    order: readonly string[];
    onOrder: (order: string[]) => void;
}) {
    const t = useTranslations("polar");
    const [dragging, setDragging] = useState<string | null>(null);
    const visible = entries.map((entry) => entry.key);
    const shown = applyOrder(entries, (entry) => entry.key, order);
    return (
        <ol className="flex flex-col gap-0.5 px-1 pb-1" aria-label={t("picker.order")}>
            {shown.map((entry, index) => (
                <li
                    key={entry.key}
                    draggable
                    onDragStart={(event) => {
                        setDragging(entry.key);
                        event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => setDragging(null)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                        event.preventDefault();
                        if (dragging && dragging !== entry.key) onOrder(moveTo(order, visible, dragging, index));
                        setDragging(null);
                    }}
                    className={cn(
                        "flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-sm",
                        dragging === entry.key && "opacity-50"
                    )}
                >
                    <GripVertical className="size-3.5 shrink-0 cursor-grab text-muted-foreground" aria-hidden />
                    {entry.icon}
                    <span className="min-w-0 flex-1 truncate" title={entry.name}>
                        {entry.name}
                    </span>
                    <button
                        type="button"
                        disabled={index === 0}
                        aria-label={t("picker.moveUp", { name: entry.name })}
                        title={t("picker.moveUp", { name: entry.name })}
                        onClick={() => onOrder(moveBy(order, visible, entry.key, -1))}
                        className="rounded p-1 text-muted-foreground hover:bg-card-hover hover:text-foreground disabled:opacity-30"
                    >
                        <ArrowUp className="size-3.5 shrink-0" aria-hidden />
                    </button>
                    <button
                        type="button"
                        disabled={index === shown.length - 1}
                        aria-label={t("picker.moveDown", { name: entry.name })}
                        title={t("picker.moveDown", { name: entry.name })}
                        onClick={() => onOrder(moveBy(order, visible, entry.key, 1))}
                        className="rounded p-1 text-muted-foreground hover:bg-card-hover hover:text-foreground disabled:opacity-30"
                    >
                        <ArrowDown className="size-3.5 shrink-0" aria-hidden />
                    </button>
                </li>
            ))}
        </ol>
    );
}
