"use client";

/**
 * A kitchen appliance: what it is doing and, where it can be, a way to stop it.
 *
 * A row says where the cook has got to - "Cooking - 12 min left" - and offers
 * Stop while there is something to stop. The panel adds what it is cooking at
 * and towards, and the time it was set for. Nothing here starts anything: an
 * appliance heating with nobody in the room is not a button this screen has.
 */

import { Loader2, Square } from "lucide-react";
import { Button, cn } from "@polaris/ui";
import { usePlacesT } from "../use-places-t";
import * as kinds from "../../lib/device-kinds";
import { controlReason } from "./device-switch";
import type { DeviceAction, DeviceCommand, DeviceView } from "../../lib/device-kinds";

/** Statuses with nothing to stop. */
const AT_REST: ReadonlySet<kinds.ApplianceStatus> = new Set(["standby", "powersave"]);

export function ApplianceControls({
    device,
    canControl,
    busy,
    onAct,
    detailed = false,
    className
}: {
    device: DeviceView;
    canControl: boolean;
    busy: DeviceAction | null;
    onAct: (action: DeviceAction, command?: DeviceCommand) => void;
    detailed?: boolean;
    className?: string;
}) {
    const t = usePlacesT();
    const view = device.appliance ?? null;
    const reason = controlReason(device, canControl, t);
    const atRest = !view?.status || AT_REST.has(view.status);
    const stop = view?.stoppable && canControl && (
        <Button
            size="sm"
            variant="outline"
            disabled={reason !== "" || busy !== null || atRest}
            title={reason || (atRest ? t("devicePanel.appliance.nothingToStop") : undefined)}
            aria-label={t("devicePanel.appliance.stopName", { name: device.name })}
            onClick={() => onAct("stop")}
        >
            {busy === "stop" ? (
                <Loader2 className="size-4 shrink-0 animate-spin" />
            ) : (
                <Square className="size-4 shrink-0" aria-hidden="true" />
            )}
            {kinds.actionText("stop", t)}
        </Button>
    );

    if (!detailed) {
        const line = view ? kinds.applianceLine(view, t) : "";
        return (
            <div className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}>
                {line && (
                    <span className="min-w-0 truncate text-sm text-muted-foreground" title={line}>
                        {line}
                    </span>
                )}
                {stop}
            </div>
        );
    }

    const rows: { label: string; value: string }[] = [];
    if (view) {
        rows.push({
            label: t("devicePanel.appliance.type"),
            value: kinds.applianceTypeText(view.type, t)
        });
        if (view.status)
            rows.push({
                label: t("devicePanel.appliance.status"),
                value: kinds.applianceStatusText(view.status, t)
            });
        if (view.program)
            rows.push({ label: t("devicePanel.appliance.program"), value: view.program });
        if (view.target !== null)
            rows.push({
                label: t("devicePanel.appliance.target"),
                value: kinds.temperatureText(view.target, view.unit)
            });
        if (view.current !== null)
            rows.push({
                label: t("devicePanel.appliance.current"),
                value: kinds.temperatureText(view.current, view.unit)
            });
        if (view.remaining !== null)
            rows.push({
                label: t("devicePanel.appliance.remaining"),
                value: kinds.applianceTime(view.remaining)
            });
        if (view.total !== null)
            rows.push({
                label: t("devicePanel.appliance.total"),
                value: kinds.applianceTime(view.total)
            });
    }

    return (
        <div className={cn("flex min-w-0 flex-col gap-3", className)}>
            {rows.length > 0 ? (
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                    {rows.map((row) => (
                        <div key={row.label} className="contents">
                            <dt className="text-muted-foreground">{row.label}</dt>
                            <dd className="min-w-0 break-words tabular-nums">{row.value}</dd>
                        </div>
                    ))}
                </dl>
            ) : (
                <p className="text-xs text-muted-foreground">
                    {t("devicePanel.appliance.unknown")}
                </p>
            )}
            {stop}
            {view && !view.stoppable && (
                <p className="text-xs text-muted-foreground">
                    {t("devicePanel.appliance.watchOnly")}
                </p>
            )}
        </div>
    );
}
