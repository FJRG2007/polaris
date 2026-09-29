"use client";

/**
 * Where the machine went.
 *
 * The split at the top is the whole point of the screen: one bar of the machine's
 * memory, divided into Polaris, the apps somebody installed, the services deployed
 * here, and whatever else is running - so the answer to "what is using this box"
 * is a glance rather than an addition. The tables under it are the same figures
 * broken down, heaviest first, because the next question is always which one.
 *
 * Polaris' own row is not a table here. Its parts, and what they occupy on disk,
 * come from the footprint endpoint (which measures volumes and is an order of
 * magnitude slower), so the card that already draws them is used as it is.
 *
 * Nothing on this screen waits for the engine: the chrome paints, the figures land
 * after, and a revisit shows the previous reading while the fresh one is on its
 * way.
 */

import Link from "next/link";
import { Fragment, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { formatBytes } from "@polaris/core";
import { useLiveResource } from "@/components/use-live-resource";
import { formatAge } from "@/app/(app)/apps/containers/freshness";
import { PolarisFootprintCard } from "@/app/(app)/apps/containers/polaris-footprint";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Badge, Button, Card, CardBody, cn, EmptyState, PageHeader, Skeleton } from "@polaris/ui";
import {
    consumedMemBytes,
    type Consumption,
    type ConsumptionGroup,
    type ConsumptionRow
} from "./types";

/** The readings come from the sampler every other screen shares, which takes a
 *  pass a minute. Polling faster than that would redraw the same numbers. */
const POLL_MS = 30_000;

/** What each group is painted in. Deliberately not the warning and danger tones:
 *  a container Polaris did not start is not a problem, and colouring it like one
 *  would say it is. */
const TONE: Record<ConsumptionGroup["id"], string> = {
    polaris: "bg-primary",
    apps: "bg-accent",
    services: "bg-success",
    // The one group that is a problem rather than a fact, and the only one
    // painted like one: what is in it is holding memory for nothing.
    leftover: "bg-warning",
    other: "bg-foreground-subtle"
};

type Translate = NamespaceTranslator<"admin">;

/**
 * A group's name and description in the reader's language.
 *
 * The server sends them in English (`lib/consumption.ts`); the group's id is what
 * the words are looked up by, so the screen reads them in any language.
 */
function groupLabel(t: Translate, id: ConsumptionGroup["id"]): string {
    return t(`consumption.groups.${id}.label`);
}

/**
 * A row's state in the reader's language.
 *
 * The server's English label carries the counts ("2 of 3 running", "3
 * restarting"), and those are read back out of it here; a label that does not
 * have them is shown as it came.
 */
function stateLabel(t: Translate, row: ConsumptionRow): string {
    const counts = (row.stateLabel.match(/\d+/g) ?? []).map(Number);
    switch (row.state) {
        case "elsewhere":
            return t("consumption.states.elsewhere");
        case "stopped":
            return t("consumption.states.stopped");
        case "running":
            return t("consumption.states.running");
        case "restarting":
            return t("consumption.states.restarting", { count: counts[0] ?? 1 });
        case "partial":
            return counts.length === 2
                ? t("consumption.running", { running: counts[0], containers: counts[1] })
                : row.stateLabel;
    }
}

export function ConsumptionView() {
    const t = useTranslations("admin");
    const { data, loading, error, stale, refreshing, refresh } = useLiveResource<Consumption>({
        url: "/api/admin/consumption",
        cacheKey: "admin.consumption",
        intervalMs: POLL_MS,
        select: (body) => body as Consumption
    });

    return (
        <>
            <PageHeader
                title={t("consumption.title")}
                description={t("consumption.description")}
                actions={
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={refresh}
                        disabled={refreshing}
                        aria-label={t("consumption.refresh")}
                        title={t("consumption.refresh")}
                    >
                        <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} />
                    </Button>
                }
            />

            {error ? (
                <EmptyState
                    title={t("consumption.error.title")}
                    description={t("consumption.error.description", { reason: error })}
                />
            ) : (
                <div className="flex flex-col gap-4">
                    {stale ? <p className="text-sm text-warning">{stale}</p> : null}
                    <ConsumptionSplit consumption={data} />
                    <PolarisFootprintCard />
                    {(data?.groups ?? []).map((group) =>
                        group.id === "polaris" ? null : (
                            <ConsumptionGroupTable key={group.id} group={group} />
                        )
                    )}
                    {loading && !data
                        ? [0, 1, 2].map((row) => <Skeleton key={row} className="h-40 w-full" />)
                        : null}
                </div>
            )}
        </>
    );
}

/** The machine as one bar. What is left over is not called free: the host's own
 *  processes are outside every container measured here, so the remainder is
 *  everything this screen cannot see plus whatever is genuinely unused. */
export function ConsumptionSplit({ consumption }: { consumption: Consumption | null }) {
    const t = useTranslations("admin");
    if (!consumption) {
        return (
            <Card>
                <CardBody className="flex flex-col gap-3">
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-4 w-80" />
                </CardBody>
            </Card>
        );
    }

    const total = consumption.machine.memTotalBytes;
    const used = consumedMemBytes(consumption);
    const groups = consumption.groups;

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{consumption.machine.name}</span>
                    <span className="text-xs text-muted-foreground">
                        {total
                            ? t("consumption.split.inContainers", { used: formatBytes(used), total: formatBytes(total) })
                            : formatBytes(used)}
                        {consumption.machine.ncpu > 0
                            ? ` - ${t("consumption.split.cores", { count: consumption.machine.ncpu })}`
                            : ""}
                        {consumption.sampledAt === null
                            ? ` - ${t("consumption.split.measuring")}`
                            : ` - ${t("consumption.split.measured", { age: formatAge(Date.now() - consumption.sampledAt) })}`}
                    </span>
                </div>

                <div
                    className="flex h-2.5 w-full overflow-hidden rounded-full bg-border"
                    role="presentation"
                >
                    {groups.map((group) => {
                        const label = groupLabel(t, group.id);
                        const share = total ? (group.memUsedBytes / total) * 100 : 0;
                        if (share <= 0) return null;
                        return (
                            <span
                                key={group.id}
                                className={cn("h-full", TONE[group.id])}
                                style={{ width: `${Math.max(0.5, share)}%` }}
                                title={t("consumption.split.segment", { label, size: formatBytes(group.memUsedBytes) })}
                            />
                        );
                    })}
                </div>

                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                    {groups.map((group) => (
                        <div key={group.id} className="flex min-w-0 flex-col gap-0.5">
                            <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <span
                                    className={cn("size-2 shrink-0 rounded-full", TONE[group.id])}
                                />
                                <span className="truncate" title={groupLabel(t, group.id)}>
                                    {groupLabel(t, group.id)}
                                </span>
                            </dt>
                            <dd className="text-sm font-medium tabular-nums">
                                {formatBytes(group.memUsedBytes)}
                                <span className="ml-1.5 text-xs font-normal text-muted-foreground tabular-nums">
                                    {t("consumption.cpu", { percent: group.cpuPercent })}
                                </span>
                            </dd>
                            <dd className="text-xs text-foreground-subtle">
                                {group.running < group.containers
                                    ? t("consumption.running", { running: group.running, containers: group.containers })
                                    : t("consumption.containers", { count: group.containers })}
                            </dd>
                        </div>
                    ))}
                </dl>

                <p className="text-xs text-muted-foreground">{t("consumption.split.note")}</p>
            </CardBody>
        </Card>
    );
}

export function ConsumptionGroupTable({ group }: { group: ConsumptionGroup }) {
    const t = useTranslations("admin");
    // Shut to begin with. An app with nine servers under it would otherwise be
    // nine rows of a table somebody opened to read four, and the app's own line
    // already carries what the nine cost between them.
    const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
    const toggle = (id: string): void =>
        setOpened((current) => {
            const next = new Set(current);
            if (!next.delete(id)) next.add(id);
            return next;
        });

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="flex min-w-0 flex-col">
                        <span className="flex items-center gap-2 text-sm font-medium">
                            <span className={cn("size-2 shrink-0 rounded-full", TONE[group.id])} />
                            {groupLabel(t, group.id)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                            {t(`consumption.groups.${group.id}.description`)}
                        </span>
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums">
                        {formatBytes(group.memUsedBytes)} - {t("consumption.cpu", { percent: group.cpuPercent })}
                        {group.running < group.containers
                            ? ` - ${t("consumption.running", { running: group.running, containers: group.containers })}`
                            : ""}
                    </span>
                </div>

                {group.rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t(`consumption.empty.${group.id === "polaris" ? "other" : group.id}`)}</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[34rem] text-sm">
                            <thead>
                                <tr className="text-left">
                                    <th className="w-full max-w-0 py-1 pr-3">{t("consumption.columns.name")}</th>
                                    <th className="py-1 pr-3">{t("consumption.columns.owner")}</th>
                                    <th className="py-1 pr-3 text-right">{t("consumption.columns.cpu")}</th>
                                    <th className="py-1 text-right">{t("consumption.columns.memory")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {group.rows.map((row) => (
                                    <Fragment key={row.id}>
                                        <Row
                                            row={row}
                                            open={opened.has(row.id)}
                                            onToggle={row.parts.length > 0 ? () => toggle(row.id) : undefined}
                                        />
                                        {opened.has(row.id)
                                            ? row.parts.map((part) => (
                                                  <Row key={part.id} row={part} inside />
                                              ))
                                            : null}
                                    </Fragment>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </CardBody>
        </Card>
    );
}

/** A container the engine keeps restarting is the one state on this screen that
 *  is wrong rather than merely quiet, so it is the only one drawn in red. */
function badge(state: ConsumptionRow["state"]): "neutral" | "warning" | "danger" {
    if (state === "restarting") return "danger";
    return state === "stopped" || state === "elsewhere" ? "neutral" : "warning";
}

function Row({
    row,
    open,
    onToggle,
    inside = false
}: {
    row: ConsumptionRow;
    open?: boolean;
    /** Set only on a row that owns something. */
    onToggle?: () => void;
    /** One of the things a row above owns, drawn under it. */
    inside?: boolean;
}) {
    const t = useTranslations("admin");
    const name = row.href ? (
        <Link href={row.href} className="font-medium hover:text-primary hover:underline">
            {row.name}
        </Link>
    ) : (
        <span className="font-medium">{row.name}</span>
    );
    const held = row.parts.length;

    return (
        <tr className={cn("align-top", inside ? "bg-surface/40" : "border-t border-border")}>
            <td className={cn("w-full max-w-0 py-2 pr-3", inside && "pl-6")}>
                <div className="flex items-center gap-2">
                    {onToggle ? (
                        <button
                            type="button"
                            onClick={onToggle}
                            aria-expanded={open}
                            aria-label={t("consumption.parts", { name: row.name })}
                            title={t("consumption.parts", { name: row.name })}
                            className="-my-1 flex shrink-0 items-center gap-1 rounded px-1 py-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                            <ChevronRight
                                className={cn("size-3.5 transition-transform", open && "rotate-90")}
                            />
                            {held}
                        </button>
                    ) : null}
                    <span className="truncate" title={row.name}>
                        {name}
                    </span>
                    {row.state === "running" ? null : (
                        <Badge variant={badge(row.state)}>{stateLabel(t, row)}</Badge>
                    )}
                </div>
                <div className="truncate text-xs text-muted-foreground" title={row.detail}>
                    {row.detail}
                    {row.containers > 1
                        ? `${row.detail ? " - " : ""}${t("consumption.containers", { count: row.containers })}`
                        : ""}
                </div>
            </td>
            <td className="py-2 pr-3 text-xs text-muted-foreground">{row.owner ?? "-"}</td>
            <td className="py-2 pr-3 text-right text-muted-foreground tabular-nums">
                {row.cpuPercent === null ? "-" : `${row.cpuPercent}%`}
            </td>
            <td className="py-2 text-right text-muted-foreground tabular-nums">
                {row.memUsedBytes === null ? "-" : formatBytes(row.memUsedBytes)}
            </td>
        </tr>
    );
}
