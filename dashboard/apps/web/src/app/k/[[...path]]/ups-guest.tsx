"use client";

/**
 * A UPS as somebody with its link sees it: how it is doing, and - for a link
 * lent control - the commands it lists. Nothing about where it is reached or
 * what it shuts down; the server never sends that.
 */

import { useState } from "react";
import { Loader2, MapPin } from "lucide-react";
import type { UpsReading } from "@/lib/ups/ups-reading";
import type { UpsGuestView } from "@/lib/ups/ups-guest";
import { whereNow, type ReportedLocation } from "@polaris/core";
import { useConfirm } from "@/components/confirm-dialog";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Skeleton,
    useToast
} from "@polaris/ui";
import {
    commandLabelKey,
    isDangerousCommand,
    minutesLeft,
    rounded,
    upsStatus
} from "@/app/(app)/places/ups/ups-words";

const POLL_MS = 15_000;

export function UpsGuest({ token, initial }: { token: string; initial: UpsGuestView }) {
    const t = useTranslations("servers");
    const words = useTranslations("publicPages");
    const toast = useToast();
    const [busy, setBusy] = useState<string | null>(null);
    const [confirm, confirmDialog] = useConfirm();
    const live = useLiveResource<UpsGuestView>({
        url: `/api/k/${token}/ups`,
        cacheKey: `ups-guest:${token}`,
        intervalMs: POLL_MS,
        select: (body) => body as UpsGuestView
    });
    const view = live.data ?? initial;
    const reading = view.reading;
    const status = upsStatus(reading ? ({ status: reading.status } as UpsReading) : null);
    const minutes = minutesLeft(reading?.runtimeS ?? null);
    const percent = (value: number | null) => {
        const shown = rounded(value);
        return shown === null ? null : `${shown}%`;
    };

    async function send(command: string, where?: ReportedLocation): Promise<string> {
        const response = await fetch(`/api/k/${token}/ups`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ command, ...(where ? { where } : {}) })
        });
        const body = (await response.json().catch(() => ({}))) as {
            outcome?: string;
            error?: string;
        };
        return body.outcome ? `ok:${body.outcome}` : (body.error ?? "closed");
    }

    async function run(command: string) {
        // Turning the output off or shutting the UPS down cuts what is plugged
        // into it: asked first, in the words the owner's own screen uses.
        if (isDangerousCommand(command)) {
            const key = commandLabelKey(command);
            const sure = await confirm({
                title: t("ups.commands.confirm.title"),
                description: t("ups.commands.confirm.danger"),
                confirmLabel: key ? t(key) : command,
                danger: true
            });
            if (!sure) return;
        }
        setBusy(command);
        let answer = await send(command);
        // A link fenced to the place says so first; only then is the browser
        // asked where it is, and the command sent once more.
        if (answer === "nearbyUnasked") {
            const where = await whereNow();
            if (where) answer = await send(command, where);
        }
        setBusy(null);
        toast.show({
            key: `ups-guest:${token}`,
            title: answer.startsWith("ok:")
                ? t(`ups.commandResult.${answer.slice(3) as "ok"}`)
                : words(`guestLink.errors.${guestError(answer)}`)
        });
        live.refresh();
    }

    const metrics = [
        { key: "charge", label: t("ups.metrics.charge"), value: percent(reading?.charge ?? null) },
        {
            key: "runtime",
            label: t("ups.metrics.runtime"),
            value: minutes === null ? null : t("ups.units.minutes", { count: minutes })
        },
        { key: "load", label: t("ups.metrics.load"), value: percent(reading?.load ?? null) }
    ];

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate" title={view.name}>
                        {view.name}
                    </span>
                    <Badge variant={status.tone}>{t(`ups.status.${status.key}`)}</Badge>
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                <dl className="grid grid-cols-3 gap-3">
                    {metrics.map((metric) => (
                        <div key={metric.key} className="flex min-w-0 flex-col gap-0.5">
                            <dt className="text-xs text-muted-foreground">{metric.label}</dt>
                            <dd className="truncate text-sm font-medium tabular-nums">
                                {live.data === undefined && !initial.reading ? (
                                    <Skeleton className="h-5 w-12" />
                                ) : (
                                    (metric.value ?? "-")
                                )}
                            </dd>
                        </div>
                    ))}
                </dl>
                {view.control && view.commands.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                        {view.commands.map((command) => {
                            const key = commandLabelKey(command);
                            return (
                                <Button
                                    key={command}
                                    size="sm"
                                    variant={isDangerousCommand(command) ? "outline" : "primary"}
                                    disabled={busy !== null}
                                    onClick={() => void run(command)}
                                >
                                    {busy === command ? (
                                        <Loader2
                                            className="size-4 shrink-0 animate-spin"
                                            aria-hidden
                                        />
                                    ) : null}
                                    {key ? t(key) : command}
                                </Button>
                            );
                        })}
                    </div>
                ) : null}
                <GuestBounds until={view.until} nearbyMeters={view.nearbyMeters} />
                {confirmDialog}
            </CardBody>
        </Card>
    );
}

/** What bounds a guest link, said under it: until when, and only near. */
export function GuestBounds({
    until,
    nearbyMeters
}: {
    until: string | null;
    nearbyMeters: number | null;
}) {
    const words = useTranslations("publicPages");
    if (!until && !nearbyMeters) return null;
    return (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            {until ? (
                <p>{words("guestLink.until", { when: new Date(until).toLocaleString() })}</p>
            ) : null}
            {nearbyMeters ? (
                <p className="flex items-center gap-1">
                    <MapPin className="size-3.5 shrink-0" aria-hidden />
                    {words("guestLink.nearby", { meters: nearbyMeters })}
                </p>
            ) : null}
        </div>
    );
}

const GUEST_ERRORS = [
    "closed",
    "notThat",
    "tooMany",
    "nearbyUnasked",
    "nearbyFar",
    "nearbyVague",
    "nearbyUnplaced"
] as const;

function guestError(error: string): (typeof GUEST_ERRORS)[number] {
    return (GUEST_ERRORS as readonly string[]).includes(error)
        ? (error as (typeof GUEST_ERRORS)[number])
        : "closed";
}
