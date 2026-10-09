"use client";

/**
 * The line under the table: a total for each column that asks for one, over
 * every row the list matches rather than the page on screen. Pressing a
 * column's foot picks which total it shows.
 */

import { useCrmT } from "./i18n";
import { Check } from "lucide-react";
import type { Total } from "../lib/totals";
import { hostUi } from "@polaris/app-host/client";
import { formatDay, formatMoney } from "./format";
import type { DisplayFormat } from "@polaris/core";
import type { CrmObject, FieldDef } from "../model/objects";
import { aggregatesFor, type Aggregate, type ViewColumn } from "../model/views";
import {
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "@polaris/ui";

/** A total as one line of text, without its label. */
export function totalText(
    field: FieldDef,
    total: Total,
    format: DisplayFormat,
    locale: string
): string {
    if (total.aggregate === "earliest" || total.aggregate === "latest") {
        if (!total.date) return "";
        return field.kind === "date" ? formatDay(total.date, format) : format.dateTime(total.date);
    }
    if (total.money) {
        return total.money.map((money) => formatMoney(money, locale)).join(" + ");
    }
    if (total.value === null) return "";
    if (total.aggregate === "percentEmpty" || total.aggregate === "percentNotEmpty") {
        return `${format.number(Math.round(total.value * 10) / 10)}%`;
    }
    const shown = format.number(
        total.aggregate === "avg" ? Math.round(total.value * 100) / 100 : total.value
    );
    return total.capped ? `${shown}+` : shown;
}

export function TotalCell({
    object,
    field,
    column,
    total,
    sticky,
    canChange,
    onChange
}: {
    object: CrmObject;
    field: FieldDef;
    column: ViewColumn;
    total: Total | undefined;
    sticky?: string;
    /** Whether the reader may change what this view totals. */
    canChange: boolean;
    onChange: (aggregate: Aggregate | null) => void;
}) {
    const t = useCrmT();
    const format = hostUi.displayFormat.useDisplayFormat();
    const locale = hostUi.i18nProvider.useLocale();
    const label = t(`fields.${object}.${field.key}` as Parameters<typeof t>[0]);
    const text = column.aggregate && total ? totalText(field, total, format, locale) : "";

    const face = (
        <span className="flex h-8 w-full min-w-0 items-center justify-end gap-1.5 px-2.5 text-[0.75rem]">
            {column.aggregate ? (
                <>
                    <span className="shrink-0 text-muted-foreground">
                        {t(`aggregates.short.${column.aggregate}`)}
                    </span>
                    <span
                        className="truncate font-medium tabular-nums text-foreground"
                        title={text}
                    >
                        {text || "-"}
                    </span>
                </>
            ) : canChange ? (
                <span className="text-foreground-subtle opacity-0 transition-opacity group-hover/foot:opacity-100">
                    {t("aggregates.add")}
                </span>
            ) : null}
        </span>
    );

    return (
        <td
            style={{ left: sticky }}
            className={cn(
                "sticky bottom-0 border-r border-t border-border bg-card p-0",
                sticky ? "z-20" : "z-10"
            )}
        >
            {canChange ? (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            className="block w-full hover:bg-card-hover"
                            aria-label={t("aggregates.choose", { field: label })}
                        >
                            {face}
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                        {aggregatesFor(field.kind).map((aggregate) => (
                            <DropdownMenuItem
                                key={aggregate}
                                onSelect={() => onChange(aggregate)}
                                className="gap-2"
                            >
                                <span className="flex-1">{t(`aggregates.long.${aggregate}`)}</span>
                                {aggregate === column.aggregate ? (
                                    <Check className="size-3.5" />
                                ) : null}
                            </DropdownMenuItem>
                        ))}
                        {column.aggregate ? (
                            <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onSelect={() => onChange(null)}>
                                    {t("aggregates.none")}
                                </DropdownMenuItem>
                            </>
                        ) : null}
                    </DropdownMenuContent>
                </DropdownMenu>
            ) : (
                face
            )}
        </td>
    );
}
