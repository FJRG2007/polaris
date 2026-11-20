"use client";

/**
 * What can be done to the chosen rows of a table, and a way to let go of them.
 *
 * Shown above a table that picks rows with `useRowSelection` (@polaris/ui) once
 * at least one is chosen. Delete is always offered; anything else a table can do
 * to several rows at once (turning them on or off, say) is passed as children.
 */

import type { ReactNode } from "react";
import { Trash2, X } from "lucide-react";
import { Button } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function SelectionBar({
    count,
    label,
    busy,
    onDelete,
    onClear,
    children
}: {
    count: number;
    /** What the region is called to a screen reader: "Chosen keys", say. */
    label: string;
    busy: boolean;
    onDelete: () => void;
    onClear: () => void;
    children?: ReactNode;
}) {
    const t = useTranslations("components");
    return (
        <div
            role="region"
            aria-label={label}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2"
        >
            <span className="text-sm font-medium">{t("selectionBar.selected", { count })}</span>
            <div className="flex flex-wrap items-center gap-1">
                {children}
                <Button size="sm" variant="danger" onClick={onDelete} disabled={busy}>
                    <Trash2 className="size-4 shrink-0" />
                    {t("selectionBar.delete", { count })}
                </Button>
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("selectionBar.clear")}
                    title={t("selectionBar.clear")}
                    onClick={onClear}
                >
                    <X className="size-4 shrink-0" />
                </Button>
            </div>
        </div>
    );
}
