"use client";

/**
 * A UPS's event log: every status flag that rose, tests, lost and found
 * links and shutdowns, newest first, filtered by kind, by whether somebody
 * has seen it, and by how far back. Marking seen is optimistic and rolls
 * back if the server refuses.
 */

import { useState } from "react";
import { Check, CheckCheck } from "lucide-react";
import * as upsEvents from "@/lib/ups/ups-events";
import type { UpsEventsAnswer } from "../ups-words";
import { acknowledgeUpsEventsAction } from "../actions";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Badge, Button, Checkbox, Select, Skeleton, useToast } from "@polaris/ui";

const DAYS = ["1", "7", "30", "90", "365"] as const;

export function UpsEventsPanel({ upsId }: { upsId: string }) {
    const t = useTranslations("servers");
    const toast = useToast();
    const [kinds, setKinds] = useState<upsEvents.UpsEventKind[]>([]);
    const [state, setState] = useState<"all" | "open" | "acknowledged">("all");
    const [days, setDays] = useState<(typeof DAYS)[number]>("30");
    const [seen, setSeen] = useState<Set<string>>(new Set());
    const query = `days=${days}&state=${state}${kinds.length ? `&kinds=${kinds.join(",")}` : ""}`;
    const live = useLiveResource<UpsEventsAnswer>({
        url: `/api/servers/ups/${upsId}/events?${query}`,
        cacheKey: `ups:${upsId}:events:${query}`,
        intervalMs: 30_000,
        select: (body) => body as UpsEventsAnswer
    });

    async function acknowledge(ids: string[] | "all") {
        const before = seen;
        const marked = ids === "all" ? (live.data?.events ?? []).map((one) => one.id) : ids;
        setSeen(new Set([...seen, ...marked]));
        const outcome = await acknowledgeUpsEventsAction(upsId, ids);
        if (!outcome.ok) {
            setSeen(before);
            toast.show({ key: `ups:${upsId}:ack`, title: t("ups.errors.failed") });
            return;
        }
        live.refresh();
    }

    function toggleKind(kind: upsEvents.UpsEventKind, on: boolean) {
        setKinds((current) => (on ? [...current, kind] : current.filter((one) => one !== kind)));
    }

    const events = live.data?.events ?? null;
    const open = live.data ? Math.max(0, live.data.open - [...seen].filter((id) => events?.some((one) => one.id === id && !one.acknowledgedAt)).length) : null;

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <Select
                    aria-label={t("ups.events.state")}
                    value={state}
                    onValueChange={(value) => setState(value as typeof state)}
                    options={(["all", "open", "acknowledged"] as const).map((one) => ({ value: one, label: t(`ups.events.states.${one}`) }))}
                    className="w-40"
                />
                <Select
                    aria-label={t("ups.events.since")}
                    value={days}
                    onValueChange={(value) => setDays(value as typeof days)}
                    options={DAYS.map((one) => ({ value: one, label: t("ups.events.days", { count: Number(one) }) }))}
                    className="w-40"
                />
                <Button
                    size="sm"
                    variant="outline"
                    aria-disabled={!open}
                    onClick={() => {
                        if (open) void acknowledge("all");
                    }}
                >
                    <CheckCheck className="size-4 shrink-0" aria-hidden />
                    {open === null ? t("ups.events.ackAll") : t("ups.events.ackAllCount", { count: open })}
                </Button>
            </div>
            <fieldset className="flex flex-wrap gap-x-4 gap-y-1.5">
                <legend className="sr-only">{t("ups.events.kinds")}</legend>
                {upsEvents.UPS_EVENT_KINDS.map((kind) => (
                    <label key={kind} className="flex items-center gap-1.5 text-xs">
                        <Checkbox checked={kinds.includes(kind)} onChange={(event) => toggleKind(kind, event.target.checked)} />
                        {t(`ups.kinds.${kind}`)}
                    </label>
                ))}
            </fieldset>
            {events === null ? (
                <div className="flex flex-col gap-2">
                    {[0, 1, 2, 3].map((one) => (
                        <Skeleton key={one} className="h-9 w-full" />
                    ))}
                </div>
            ) : events.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("ups.events.empty")}</p>
            ) : (
                <ul className="flex flex-col divide-y rounded-md border">
                    {events.map((event) => {
                        const acknowledged = event.acknowledgedAt !== null || seen.has(event.id);
                        return (
                            <li key={event.id} className="flex min-w-0 items-center gap-3 px-3 py-2 text-sm">
                                <Badge variant={upsEvents.UPS_EVENT_TONE[event.kind]}>{t(`ups.kinds.${event.kind}`)}</Badge>
                                <span className="min-w-0 flex-1 truncate text-muted-foreground" title={event.detail ?? undefined}>
                                    {event.detail ?? ""}
                                </span>
                                <time dateTime={event.ts} className="shrink-0 tabular-nums text-muted-foreground">
                                    {new Date(event.ts).toLocaleString()}
                                </time>
                                {acknowledged ? (
                                    <span className="w-8 shrink-0 text-center" title={t("ups.events.acknowledged")}>
                                        <Check className="mx-auto size-4 shrink-0 text-muted-foreground" aria-label={t("ups.events.acknowledged")} />
                                    </span>
                                ) : (
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        aria-label={t("ups.events.ack")}
                                        title={t("ups.events.ack")}
                                        onClick={() => void acknowledge([event.id])}
                                    >
                                        <Check className="size-4 shrink-0" aria-hidden />
                                    </Button>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
            {live.data?.more ? <p className="text-xs text-muted-foreground">{t("ups.events.more")}</p> : null}
        </div>
    );
}
