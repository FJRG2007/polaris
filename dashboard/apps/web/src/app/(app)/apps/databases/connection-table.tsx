"use client";

/**
 * The databases somebody can open, as a table.
 *
 * It was a grid of cards, which is the right shape for three connections and the
 * wrong one for twenty: the facts people scan for - which engine, where it lives,
 * whether it answers - sat at a different place on every card. In columns they line
 * up, so the one on another server or the one that stopped answering is found by
 * reading down rather than across.
 *
 * The table is its own scroller, both ways. The screen around it fills the window
 * and clips what overflows (the workbench needs that), so a list that grows past
 * the fold has to scroll inside itself, and a phone scrolls it sideways rather than
 * crushing seven columns into unreadable ones. It hugs its rows until there are too
 * many, and only then does it shrink and scroll.
 */

import * as list from "./connection-list";
import { dbEngineLabel } from "@polaris/core";
import type { MouseEvent, ReactNode } from "react";
import { Badge, Button, Skeleton } from "@polaris/ui";
import { RelativeTime } from "@/components/relative-time";
import { DbEngineIcon } from "@/components/db-engine-icon";
import { useDisplayFormat } from "@/components/display-format";
import type { DataConnectionView } from "@/lib/data/connections";
import { ArrowRight, Loader2, Pencil, Plug, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { dataText, whereText } from "@/lib/data/words";

/** Seven data columns and the actions. */
const COLUMNS = 8;

export interface ConnectionTableProps {
    /** Null while the list is still on its way: the chrome paints, the rows skeleton. */
    rows: DataConnectionView[] | null;
    tested: Record<string, list.TestOutcome>;
    testing: string | null;
    onOpen: (connection: DataConnectionView) => void;
    onTest: (connection: DataConnectionView) => void;
    onEdit: (connection: DataConnectionView) => void;
    /** Save a database Polaris runs as a connection of one's own. */
    onSave: (connection: DataConnectionView) => void;
    onRemove: (connection: DataConnectionView) => void;
    /** Shown in place of rows when the filters leave none. */
    noMatch: ReactNode;
}

export function ConnectionTable({ rows, noMatch, ...row }: ConnectionTableProps) {
    const t = useTranslations("databases");
    return (
        <div className="min-h-0 overflow-auto overscroll-contain rounded-lg border border-border">
            <table className="w-full min-w-[56rem] text-sm">
                <thead className="sticky top-0 z-10 bg-surface text-left text-xs text-muted-foreground">
                    <tr>
                        <th scope="col" className="w-full max-w-0 px-3 py-2 font-medium">
                            {t("dialog.name")}
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">{t("dialog.engine")}</th>
                        <th scope="col" className="px-3 py-2 font-medium">{t("list.columns.where")}</th>
                        <th scope="col" className="px-3 py-2 font-medium">{t("dialog.database")}</th>
                        <th scope="col" className="px-3 py-2 font-medium">{t("list.columns.status")}</th>
                        <th scope="col" className="px-3 py-2 font-medium">{t("list.columns.lastUsed")}</th>
                        <th scope="col" className="px-3 py-2 font-medium">{t("list.columns.added")}</th>
                        <th scope="col" className="px-3 py-2 font-medium">
                            <span className="sr-only">{t("list.columns.actions")}</span>
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {rows === null ? (
                        [0, 1, 2, 3].map((index) => <SkeletonRow key={index} />)
                    ) : rows.length === 0 ? (
                        <tr>
                            <td colSpan={COLUMNS} className="px-3 py-8 text-center">
                                {noMatch}
                            </td>
                        </tr>
                    ) : (
                        rows.map((connection) => (
                            <ConnectionRow key={connection.id} connection={connection} {...row} />
                        ))
                    )}
                </tbody>
            </table>
        </div>
    );
}

function SkeletonRow() {
    return (
        <tr aria-hidden="true" className="border-t border-border">
            <td className="w-full max-w-0 px-3 py-2.5">
                <span className="flex items-center gap-3">
                    <Skeleton className="size-7 shrink-0 rounded-md" />
                    <Skeleton className="h-4 w-40" />
                </span>
            </td>
            {["w-24", "w-32", "w-20", "w-20", "w-16", "w-16", "w-20"].map((width, index) => (
                <td key={index} className="px-3 py-2.5">
                    <Skeleton className={`h-4 ${width}`} />
                </td>
            ))}
        </tr>
    );
}

/** A dash for a fact this row does not have, rather than an empty cell that reads
 *  as still loading. */
function Absent() {
    return <span className="text-foreground-subtle">-</span>;
}

function ConnectionRow({
    connection,
    tested,
    testing,
    onOpen,
    onTest,
    onEdit,
    onSave,
    onRemove
}: Omit<ConnectionTableProps, "rows" | "noMatch"> & { connection: DataConnectionView }) {
    const t = useTranslations("databases");
    const format = useDisplayFormat();
    const test = tested[connection.id];
    const status = list.statusOf(connection, test);
    const version = test?.ok ? list.shortVersion(test.detail) : null;
    const engine = dbEngineLabel(connection.engine);
    const home = list.homeOf(connection);
    const busy = testing === connection.id;

    // The actions sit inside a row that opens on click; a press on one of them is
    // that action and nothing else.
    const only = (run: () => void) => (event: MouseEvent) => {
        event.stopPropagation();
        run();
    };

    return (
        <tr
            onClick={() => onOpen(connection)}
            className="cursor-pointer border-t border-border hover:bg-card-hover"
        >
            <td className="w-full max-w-0 px-3 py-2">
                <span className="flex min-w-0 items-center gap-3">
                    <DbEngineIcon engine={connection.engine} className="size-7 shrink-0" />
                    <span className="min-w-0">
                        <span className="flex min-w-0 items-center gap-1.5">
                            {/* The keyboard's way in; the row is the pointer's. */}
                            <button
                                type="button"
                                onClick={only(() => onOpen(connection))}
                                className="min-w-0 truncate text-left font-medium hover:underline"
                                title={connection.name}
                            >
                                {connection.name}
                            </button>
                            {connection.readOnly && <Badge>{t("view.readOnly")}</Badge>}
                        </span>
                        {connection.note && (
                            <span
                                className="block truncate text-xs text-muted-foreground"
                                title={dataText(t, connection.note)}
                            >
                                {dataText(t, connection.note)}
                            </span>
                        )}
                    </span>
                </span>
            </td>
            <td className="whitespace-nowrap px-3 py-2">
                <span title={test?.ok ? test.detail : undefined}>
                    {engine}
                    {version && <span className="text-muted-foreground"> {version}</span>}
                </span>
            </td>
            <td className="px-3 py-2">
                <span className="flex flex-col items-start gap-0.5">
                    <Badge variant={home === "external" ? "neutral" : "primary"}>
                        {t(`list.homes.${home}`)}
                    </Badge>
                    <span
                        className="block max-w-[14rem] truncate text-xs text-muted-foreground"
                        title={whereText(t, connection.where)}
                    >
                        {whereText(t, connection.where)}
                    </span>
                </span>
            </td>
            <td className="px-3 py-2">
                {connection.database ? (
                    <span className="block max-w-[10rem] truncate" title={connection.database}>
                        {connection.database}
                    </span>
                ) : (
                    <Absent />
                )}
            </td>
            <td className="whitespace-nowrap px-3 py-2">
                <Badge variant={status.tone} title={status.detail ? dataText(t, status.detail) : undefined}>
                    {t(`list.status.${status.state}`)}
                </Badge>
            </td>
            <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                {connection.lastUsedAt ? (
                    <span title={format.dateTime(connection.lastUsedAt)}>
                        <RelativeTime iso={connection.lastUsedAt} />
                    </span>
                ) : connection.origin === "saved" ? (
                    t("list.never")
                ) : (
                    <Absent />
                )}
            </td>
            <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                {connection.createdAt ? format.date(connection.createdAt) : <Absent />}
            </td>
            <td className="px-3 py-1.5">
                <span className="flex items-center justify-end gap-0.5">
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        title={t("list.open")}
                        aria-label={t("list.openNamed", { name: connection.name })}
                        onClick={only(() => onOpen(connection))}
                    >
                        <ArrowRight className="size-4" />
                    </Button>
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        title={t("list.test")}
                        aria-label={t("list.testNamed", { name: connection.name })}
                        disabled={busy}
                        onClick={only(() => onTest(connection))}
                    >
                        {busy ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Plug className="size-4" />
                        )}
                    </Button>
                    {connection.origin === "saved" ? (
                        <>
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                title={t("list.edit")}
                                aria-label={t("list.editNamed", { name: connection.name })}
                                onClick={only(() => onEdit(connection))}
                            >
                                <Pencil className="size-4" />
                            </Button>
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                title={t("view.remove")}
                                aria-label={t("list.removeNamed", { name: connection.name })}
                                onClick={only(() => onRemove(connection))}
                            >
                                <Trash2 className="size-4" />
                            </Button>
                        </>
                    ) : (
                        connection.origin === "managed" && (
                            // The way to give it a name of your own, or to write to
                            // it: what is listed here is read-only on purpose.
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                title={t("list.save")}
                                aria-label={t("list.saveNamed", { name: connection.name })}
                                onClick={only(() => onSave(connection))}
                            >
                                <Plus className="size-4" />
                            </Button>
                        )
                    )}
                </span>
            </td>
        </tr>
    );
}
